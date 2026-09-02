/**
 * Toconline -> Google Sheet stock sync
 *
 * Pulls this month's finalized sales invoices from Toconline and writes the
 * total quantity sold per product into this month's "SOLD" column of the
 * active stock sheet (first sheet/tab of this spreadsheet).
 *
 * One-time setup: see SETUP.md next to this file. In short:
 *   1. Add the "OAuth2 for Apps Script" library (script ID in SETUP.md).
 *   2. Set Script Properties: TOCONLINE_CLIENT_ID, TOCONLINE_SECRET,
 *      TOCONLINE_OAUTH_URL, TOCONLINE_API_URL.
 *   3. Deploy as a Web App, run authorize(), open the logged URL once.
 *   4. Run syncStock() once manually to verify, then installTrigger().
 */

var SHEET_NAME = 'STOCK 26';
var LOG_SHEET_NAME = 'Sync Log';
var PRODUCT_COL = 1;     // column A
var BATCH_COL = 2;       // column B
var STOCK_LEFT_COL = 3;  // column C ("STOCK LEFT OFFICE") - the active batch is the one still holding office stock, not total stock across all locations
var HEADER_ROW_MONTH = 2; // row with month labels (merged across each block)
var HEADER_ROW_FIELD = 3; // row with SOLD/GIFTED/TESTER/BROKEN labels
var FIRST_DATA_ROW = 4;   // first product row

// ---------- OAuth2 (Toconline) ----------

function getToconlineService_() {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('TOCONLINE_CLIENT_ID');
  var secret = props.getProperty('TOCONLINE_SECRET');

  // Confirmed via Toconline's own Postman collection: client_id/client_secret
  // go in the token request BODY, not a Basic auth header. Postman also does
  // NOT resend "scope" on the token exchange (only on the /auth step) - the
  // OAuth2 library does by default, so strip it here to match exactly.
  return OAuth2.createService('toconline')
    .setAuthorizationBaseUrl(props.getProperty('TOCONLINE_OAUTH_URL') + '/auth')
    .setTokenUrl(props.getProperty('TOCONLINE_OAUTH_URL') + '/token')
    .setClientId(clientId)
    .setClientSecret(secret)
    .setCallbackFunction('authCallback_')
    // Script-wide store (not per-user): the 10-minute trigger and anyone
    // clicking "Actualiser maintenant" from the menu must share the same
    // token, otherwise only the person who ran authorize() has access and
    // everyone else keeps hitting "not authorized yet" (2026-08-03).
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setScope('commercial')
    .setParam('response_type', 'code')
    .setTokenPayloadHandler(function (payload) {
      delete payload.scope;
      return payload;
    });
}

// Run this once from the editor, then open the URL it logs.
function authorize() {
  var service = getToconlineService_();
  if (service.hasAccess()) {
    Logger.log('Already authorized.');
  } else {
    Logger.log('Open this URL to authorize: %s', service.getAuthorizationUrl());
  }
}

// Required entry point for the OAuth2 library's redirect (Web App deployment).
function doGet(e) {
  return authCallback_(e);
}

function authCallback_(request) {
  var service = getToconlineService_();
  var authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlOutput_('Success! Toconline is authorized. You can close this tab.');
  }
  return HtmlOutput_('<pre>Denied or error. Query params: ' + JSON.stringify(request.parameter) + '</pre>');
}

function HtmlOutput_(message) {
  return HtmlService.createHtmlOutput(message);
}

// Utility if you ever need to redo authorization from scratch.
function resetToconlineAuth() {
  getToconlineService_().reset();
}

// ---------- Toconline API ----------

function fetchThisMonthInvoiceLines_(refDate) {
  var props = PropertiesService.getScriptProperties();
  var apiUrl = props.getProperty('TOCONLINE_API_URL');
  var service = getToconlineService_();
  if (!service.hasAccess()) {
    throw new Error('Toconline is not authorized yet. Run authorize() first.');
  }

  // refDate lets a one-off backfill recount a PAST month; when omitted it
  // defaults to now - the live path used by the 10-minute trigger and the menu.
  var now = refDate || new Date();
  var tz = Session.getScriptTimeZone();
  var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  var quantities = {}; // normalized product name -> total quantity
  var observations = []; // "Observacoes" (notes field) of every counted invoice, in order
  var giftedQuantities = {}; // same, for 0-euro ("gifted") invoices
  var giftedObservations = [];
  var testerQuantities = {}; // lines whose description contains "tester" - counted here instead of SOLD/GIFTED
  var totalDocs = 0;

  // Confirmed by direct testing: this endpoint has no working pagination
  // (?page=N and page[number]/page[size] are both ignored) and no
  // links/meta in the response - it always returns the full document
  // history in one shot, oldest first. So a single fetch is both correct
  // and necessary; looping on "page" just re-fetched the same full list
  // every time and reliably timed out the script after 6 minutes.
  var url = apiUrl.replace(/\/$/, '') + '/api/v1/commercial_sales_documents/';
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + service.getAccessToken(),
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Toconline API error (' + response.getResponseCode() + '): ' + response.getContentText());
  }

  var body = JSON.parse(response.getContentText());
  var docs = body.data || body; // tolerate either {data:[...]} or a bare array

  docs.forEach(function (doc) {
    // Only finalized invoices ("FT"): status 1 = finalized, document_no assigned.
    // Skip drafts/unfinalized documents and credit notes / other doc types.
    if (doc.document_type !== 'FT') return;
    if (doc.status !== 1 || !doc.document_no) return;

    var docDate = new Date(doc.date || doc.document_date);
    if (docDate < monthStart || docDate >= monthEnd) return;

    totalDocs++;
    var note = (doc.notes || '').toString().trim();

    // Invoices whose Observacoes mention "consignment" record stock that was
    // already sold/removed elsewhere (e.g. logged retroactively) - skip
    // both their quantities and their note entirely.
    if (/consignment/i.test(note)) return;

    // A finalized invoice totalling 0 EUR is stock given away, not sold -
    // route its quantities (and its note) to GIFTED instead of SOLD.
    var isGifted = Number(doc.gross_total) === 0;
    var targetQuantities = isGifted ? giftedQuantities : quantities;
    if (isGifted) {
      if (note) giftedObservations.push(note);
    } else {
      if (note) observations.push(note);
    }

    // A few one-off invoices should only have their FIRST product line counted
    // toward this sheet's stock; the remaining lines were handled/fulfilled
    // elsewhere and are not stock movements here (user-confirmed per document).
    // See DOCUMENT_FIRST_LINE_ONLY.
    var firstLineOnly = DOCUMENT_FIRST_LINE_ONLY[doc.document_no];
    var countedFirstLine = false;

    (doc.lines || doc.commercial_sales_document_lines || []).forEach(function (line) {
      var name = line.description || line.name || '';
      var qty = Number(line.quantity || 0);
      if (!name || !qty) return;
      if (isNonProductLine_(name)) return;
      if (firstLineOnly && countedFirstLine) return; // keep only the first product line
      countedFirstLine = true;
      // "Tester" lines (e.g. "Tester Citrusy Joy spray 30ml") are neither
      // sold nor gifted stock - they go to their own TESTER column,
      // overriding both the SOLD and the 0-euro/GIFTED routing above.
      var isTester = /\btester\b/i.test(name);
      var destQuantities = isTester ? testerQuantities : targetQuantities;
      var key = DOCUMENT_PRODUCT_OVERRIDES[doc.document_no] || normalizeProductName_(name);
      var components = BUNDLE_COMPONENTS[key];
      if (components) {
        components.forEach(function (componentKey) {
          destQuantities[componentKey] = (destQuantities[componentKey] || 0) + qty;
        });
        return;
      }
      destQuantities[key] = (destQuantities[key] || 0) + qty;
    });
  });

  Logger.log('Scanned %s invoices for %s', totalDocs, Utilities.formatDate(now, tz, 'yyyy-MM'));
  return {
    quantities: quantities,
    observations: observations,
    giftedQuantities: giftedQuantities,
    giftedObservations: giftedObservations,
    testerQuantities: testerQuantities
  };
}

// One-off corrections for specific invoices where the wrong product was
// picked on Toconline at the time of sale (human data-entry error, confirmed
// by the user per document) - keyed by document_no, value is the correct
// normalized product key. Overrides normalizeProductName_(line description)
// entirely for every line on that document.
var DOCUMENT_PRODUCT_OVERRIDES = {
  'FT IR2026/6': 'CITRUSY JOY 30ML' // invoice said "Hands Cleaner Citrus" but was actually Citrusy Joy
};

// Invoices where ONLY the first product line counts toward this sheet's stock;
// every other line on the document is ignored. For one-off B2B invoices whose
// remaining lines were fulfilled/handled elsewhere and must not decrement stock
// here (user-confirmed per document).
var DOCUMENT_FIRST_LINE_ONLY = {
  'FT 2026PT/164': true // only the first line (30x Peaceful Mind) counts; rest of this invoice ignored (user-confirmed 2026-09-01)
};

// Line items that show up on Toconline invoices but aren't stock products
// (shipping fees etc.) - excluded before matching, not counted as unmatched.
var NON_PRODUCT_LINES = ['DELIVERY', 'SHIPPING', 'PORTES', 'PORTE'];

function isNonProductLine_(name) {
  return NON_PRODUCT_LINES.indexOf(name.toString().trim().toUpperCase()) !== -1;
}

// Marketing/format words Toconline includes in invoice descriptions that
// don't appear in the sheet's simplified product names, e.g. Toconline
// "BODY TENDERNESS COSMOS OIL 100ML" vs sheet "Body Tenderness". Stripped
// on both sides so the two naming styles converge to the same key.
var NOISE_WORDS = ['COSMOS', 'ECOCERT', 'OIL', 'SPRAY', 'ROLL-ON', 'ROLLON', 'TESTER'];

// Bundle/kit products sold as one Toconline line but that should count
// toward each component product's own SOLD total - per the user's
// bundling rules (2026-07-22). Component keys must match exactly what
// normalizeProductName_ produces for a DIRECT sale of that product on
// Toconline (i.e. including its size, e.g. "REFRESHED MIND 10ML") - not
// the sheet's own (sometimes size-less) key. Otherwise a product sold
// both directly and inside a bundle ends up under two different keys in
// the quantities map, and the second sheet write silently clobbers the
// first instead of adding to it.
var BUNDLE_COMPONENTS = {
  'DUO SPORT': ['BODY TENDERNESS 100ML', 'YOGA MAT PURIFIER 50ML'],
  'DUO ENERGIE BOOST': ['REFRESHED MIND 10ML', 'CITRUSY JOY 30ML'],
  'DUO SENSUEL': ['OFADISIA MEN 100ML', 'OFADISIA WOMEN 100ML'],
  'DUO SOMMEIL': ['NIGHT POTION 10ML', 'DREAMY PILLOW 50ML'],
  'SUMMER TRAVEL KIT': ['REFRESHED MIND 10ML', 'CITRUSY JOY 30ML', 'DREAMY PILLOW 30ML'],
  'DUO IMMUNITE': ['SEASONAL BOOST 10ML', 'DAILY DEFENSE 50ML']
};

function normalizeProductName_(name) {
  var n = name
    .toString()
    .replace(/\([^)]*\)/g, '') // drop "(NEW)", "(2026)" etc.
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents: "Énergie" -> "Energie"
    .toUpperCase();
  NOISE_WORDS.forEach(function (word) {
    n = n.replace(new RegExp('\\b' + word + '\\b', 'g'), '');
  });
  n = n.replace(/(\d+)\s+(ML|G|GR|L)\b/g, '$1$2'); // "10 ML" -> "10ML"
  return n.replace(/\s+/g, ' ').trim();
}

// Strips a trailing size (e.g. "100ML") to get a size-less base key, used
// as a fallback match only when it resolves to exactly one sheet product -
// e.g. "Hands Cleaner Lavender" has no size in the sheet at all, while
// Toconline's line for it does.
function baseProductKey_(key) {
  return key.replace(/\s*\d+(ML|G|GR|L)\b/g, '').replace(/\s+/g, ' ').trim();
}

// ---------- Sheet update ----------

function syncStock() {
  syncStockForDate_(new Date());
}

// One-off backfill for a PAST month - e.g. to recover a month missed during an
// auth outage. Recounts that whole month from Toconline and rewrites ONLY that
// month's columns; the current month and every other month are untouched.
// `month` is 1-12. Day 15 just lands safely inside the month regardless of
// timezone. Example, from the editor: syncStockForMonth(2026, 8) // August.
function syncStockForMonth(year, month) {
  syncStockForDate_(new Date(year, month - 1, 15));
}

function syncStockForDate_(refDate) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  var logSheet = getOrCreateLogSheet_(ss);

  try {
    var result = fetchThisMonthInvoiceLines_(refDate);
    var soldCol = findCurrentMonthFieldColumn_(sheet, 'SOLD', refDate);
    var giftedCol = findCurrentMonthFieldColumn_(sheet, 'GIFTED', refDate);
    var testerCol = findCurrentMonthFieldColumn_(sheet, 'TESTER', refDate);
    var lastRow = sheet.getLastRow();

    var products = sheet.getRange(FIRST_DATA_ROW, PRODUCT_COL, lastRow - FIRST_DATA_ROW + 1, 1).getValues();
    var stockLeft = sheet.getRange(FIRST_DATA_ROW, STOCK_LEFT_COL, lastRow - FIRST_DATA_ROW + 1, 1).getValues();

    // Group rows by normalized product name, remembering which row (if any)
    // is the "active batch" (the one still holding stock). Also index by a
    // size-less base key, as a fallback for sheet products that carry no
    // size in their name at all (see baseProductKey_).
    var rowsByProduct = {};
    var keysByBase = {};
    for (var i = 0; i < products.length; i++) {
      var rawName = products[i][0];
      if (!rawName) continue;
      var key = normalizeProductName_(rawName);
      var row = FIRST_DATA_ROW + i;
      var hasStock = Number(stockLeft[i][0] || 0) > 0;
      if (!rowsByProduct[key]) rowsByProduct[key] = [];
      rowsByProduct[key].push({ row: row, hasStock: hasStock });

      var baseKey = baseProductKey_(key);
      if (!keysByBase[baseKey]) keysByBase[baseKey] = [];
      if (keysByBase[baseKey].indexOf(key) === -1) keysByBase[baseKey].push(key);
    }

    var soldResult = writeQuantitiesToColumn_(sheet, soldCol, result.quantities, rowsByProduct, keysByBase, lastRow);
    var giftedResult = writeQuantitiesToColumn_(sheet, giftedCol, result.giftedQuantities, rowsByProduct, keysByBase, lastRow);
    var testerResult = writeQuantitiesToColumn_(sheet, testerCol, result.testerQuantities, rowsByProduct, keysByBase, lastRow);

    // "comments" row: every invoice's Observacoes for the month, one per
    // line, under the matching SOLD/GIFTED column. Overwritten in full each
    // run (not appended) so re-running never duplicates entries.
    var commentsRow = findCommentsRow_(sheet, lastRow);
    if (commentsRow) {
      sheet.getRange(commentsRow, soldCol).setValue(result.observations.join('\n'));
      sheet.getRange(commentsRow, giftedCol).setValue(result.giftedObservations.join('\n'));
    }

    var updated = soldResult.updated
      .concat(giftedResult.updated.map(function (u) { return u + ' (GIFTED)'; }))
      .concat(testerResult.updated.map(function (u) { return u + ' (TESTER)'; }));
    var unmatched = soldResult.unmatched
      .concat(giftedResult.unmatched.map(function (u) { return u + ' (GIFTED)'; }))
      .concat(testerResult.unmatched.map(function (u) { return u + ' (TESTER)'; }));
    logRun_(logSheet, 'OK', updated, unmatched);
  } catch (err) {
    logRun_(logSheet, 'ERROR: ' + err.message, [], []);
    throw err;
  }
}

// Writes a quantities map (product key -> qty) into one column, matching
// each key to its sheet row the same way for SOLD and GIFTED. Resets the
// whole column first: each run's map is the full, authoritative recount
// for the month, not a delta - otherwise a product whose only invoice
// drops out (e.g. via the "consignment" filter) would keep a stale qty from a
// previous run instead of clearing back to blank.
function writeQuantitiesToColumn_(sheet, col, quantities, rowsByProduct, keysByBase, lastRow) {
  var updated = [];
  var unmatched = [];

  sheet.getRange(FIRST_DATA_ROW, col, lastRow - FIRST_DATA_ROW + 1, 1).clearContent();

  Object.keys(quantities).forEach(function (key) {
    var candidates = rowsByProduct[key];
    if (!candidates) {
      var baseMatches = keysByBase[baseProductKey_(key)];
      if (baseMatches && baseMatches.length === 1) {
        candidates = rowsByProduct[baseMatches[0]];
      }
    }
    if (!candidates || candidates.length === 0) {
      unmatched.push(key + ' (qty ' + quantities[key] + ')');
      return;
    }
    var target = candidates.length === 1 ? candidates[0] : findActiveBatchRow_(candidates);
    if (!target) {
      unmatched.push(key + ' (qty ' + quantities[key] + ') - multiple batches, ambiguous stock-left match');
      return;
    }
    sheet.getRange(target.row, col).setValue(quantities[key]);
    updated.push(key + ' -> row ' + target.row + ' = ' + quantities[key]);
  });

  return { updated: updated, unmatched: unmatched };
}

// Row labelled "comments" in column A (below the product list) - not a
// fixed row number since the product list can grow/shrink over time.
var COMMENTS_ROW_LABEL = 'comments';

function findCommentsRow_(sheet, lastRow) {
  var labels = sheet.getRange(1, PRODUCT_COL, lastRow, 1).getValues();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i][0] && labels[i][0].toString().trim().toLowerCase() === COMMENTS_ROW_LABEL) {
      return i + 1;
    }
  }
  return null;
}

function findActiveBatchRow_(candidates) {
  var withStock = candidates.filter(function (c) { return c.hasStock; });
  return withStock.length === 1 ? withStock[0] : null;
}

function findCurrentMonthFieldColumn_(sheet, fieldName, refDate) {
  var lastCol = sheet.getLastColumn();
  var monthRow = sheet.getRange(HEADER_ROW_MONTH, 1, 1, lastCol).getValues()[0];
  var fieldRow = sheet.getRange(HEADER_ROW_FIELD, 1, 1, lastCol).getValues()[0];

  var currentMonthName = Utilities.formatDate(refDate || new Date(), Session.getScriptTimeZone(), 'MMMM').toUpperCase();
  var lastMonthSeen = '';

  for (var c = 0; c < lastCol; c++) {
    var label = monthRow[c] ? monthRow[c].toString().trim().toUpperCase() : '';
    if (label) lastMonthSeen = label;
    var field = fieldRow[c] ? fieldRow[c].toString().trim().toUpperCase() : '';
    if (lastMonthSeen === currentMonthName && field === fieldName) {
      return c + 1; // 1-indexed column
    }
  }
  throw new Error('Could not find a ' + fieldName + ' column for ' + currentMonthName + ' - check the header rows.');
}

// ---------- Logging ----------

function getOrCreateLogSheet_(ss) {
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Status', 'Updated', 'Unmatched']);
  }
  return sheet;
}

function logRun_(logSheet, status, updated, unmatched) {
  logSheet.appendRow([
    new Date(),
    status,
    updated.join(' | '),
    unmatched.join(' | ')
  ]);
}

// ---------- Menu button ----------

// Simple trigger: Google Sheets calls this automatically whenever the
// spreadsheet is opened, adding a "Toconline Sync" menu next to Aide.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Toconline Sync')
    .addItem('Actualiser maintenant', 'manualSync')
    .addToUi();
}

// Menu entry point: runs syncStock() on demand (same logic as the 10-minute
// trigger) and shows the result as a toast instead of a raw error dialog.
function manualSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Synchronisation en cours...', 'Toconline', 5);
  try {
    syncStock();
    ss.toast('Synchronisation terminee - voir l\'onglet "Sync Log" pour le detail.', 'Toconline', 6);
  } catch (err) {
    ss.toast('Erreur : ' + err.message, 'Toconline', 10);
  }
}

// ---------- Trigger management ----------

// Run once, manually, after a successful manual syncStock() test.
function installTrigger() {
  removeExistingTriggers_();
  ScriptApp.newTrigger('syncStock').timeBased().everyMinutes(10).create();
  Logger.log('Trigger installed: syncStock every 10 minutes.');
}

function removeExistingTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncStock') ScriptApp.deleteTrigger(t);
  });
}
