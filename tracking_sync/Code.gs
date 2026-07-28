/**
 * Ofa Karri - Synchronisation automatique des numéros de suivi
 * TNT / Fedex / CTT -> Google Sheet "TEST SHIPPING FOLLOW UP" (onglet "Feuille 1")
 *
 * Lit les emails de confirmation d'expédition reçus dans Gmail
 * (ofakarri.marketing@gmail.com, y compris ceux adressés à bonjour@ofakarri.com)
 * et ajoute une ligne par nouveau numéro de suivi détecté.
 */

var SHEET_ID = '1r4Uu5wexAilPG2Cbhx1ux491yycIS406WMJqt0COqEI';
var TAB_NAME = 'Feuille 1';

var HEADER_ROW = 3;
var DATA_START_ROW = 4;
var COL_FOR_WHO = 2;   // B - "For who ?"
var COL_WHEN = 3;      // C - "When ?"
var COL_TRACKING = 4;  // D - "Tracking"
var COL_STATUS = 5;    // E - "Delivery status"
var COL_CARRIER = 8;   // H - "Transporteur" (ajoutée par ce script ; F/G sont déjà "Price orders"/"Price gifting")
var COL_MONTH = 9;     // I - "Mois"

var MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

var PROCESSED_LABEL = 'TrackingSync-Processed';

var CARRIERS = [
  {
    name: 'TNT',
    gmailQuery: 'subject:"prise en compte"',
    extract: extractTNT
  },
  {
    name: 'CTT',
    gmailQuery: 'subject:(encomenda caminho)',
    extract: extractCTT
  }
  // Fedex : en attente d'un exemple d'email de confirmation pour définir
  // la requête Gmail et le parseur correspondants. À compléter ensuite.
];

function runTrackingSync() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);
  ensureCarrierColumn(sheet);
  ensureMonthColumn(sheet);

  var label = getOrCreateLabel(PROCESSED_LABEL);
  var existingTracking = getExistingTrackingNumbers(sheet);
  var addedCount = 0;

  CARRIERS.forEach(function (carrier) {
    var query = carrier.gmailQuery + ' -label:' + PROCESSED_LABEL;
    var threads = GmailApp.search(query, 0, 50);

    threads.forEach(function (thread) {
      var messages = thread.getMessages();
      messages.forEach(function (message) {
        var data = carrier.extract(message);
        if (data && data.tracking && existingTracking.indexOf(data.tracking) === -1) {
          appendTrackingRow(sheet, carrier.name, data.forWho || '', data.tracking, message.getDate());
          existingTracking.push(data.tracking);
          addedCount++;
        }
      });
      thread.addLabel(label);
    });
  });

  reorganizeMonthGroups(sheet);
  applyVisualStyle(sheet);

  return addedCount;
}

// ---- Regroupement par mois (cellules fusionnées) + mise en forme ----

function reorganizeMonthGroups(sheet) {
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - DATA_START_ROW + 1;
  if (numRows < 1) return;

  var monthRange = sheet.getRange(DATA_START_ROW, COL_MONTH, numRows, 1);
  monthRange.breakApart();

  sheet.getRange(DATA_START_ROW, COL_FOR_WHO, numRows, COL_MONTH - COL_FOR_WHO + 1)
    .sort({ column: COL_WHEN, ascending: true });

  var dates = sheet.getRange(DATA_START_ROW, COL_WHEN, numRows, 1).getValues();
  var labels = dates.map(function (row) {
    return row[0] ? getMonthLabel(row[0]) : '';
  });
  sheet.getRange(DATA_START_ROW, COL_MONTH, numRows, 1).setValues(labels.map(function (v) { return [v]; }));

  var colors = ['#eef3fc', '#ffffff'];
  var colorIndex = 0;
  var startIndex = 0;
  for (var i = 1; i <= numRows; i++) {
    var isBoundary = (i === numRows) || (labels[i] !== labels[startIndex]);
    if (isBoundary) {
      var blockRow = DATA_START_ROW + startIndex;
      var blockLength = i - startIndex;
      var blockRange = sheet.getRange(blockRow, COL_MONTH, blockLength, 1);
      if (blockLength > 1) blockRange.merge();
      blockRange
        .setVerticalAlignment('middle')
        .setHorizontalAlignment('center')
        .setFontWeight('bold')
        .setBackground(colors[colorIndex % 2]);
      colorIndex++;
      startIndex = i;
    }
  }
}

function applyVisualStyle(sheet) {
  var lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  var numRows = lastRow - DATA_START_ROW + 1;
  var width = COL_MONTH - COL_FOR_WHO + 1;

  sheet.getRange(HEADER_ROW, COL_FOR_WHO, 1, width)
    .setBackground('#1c4587')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.setFrozenRows(HEADER_ROW);

  var tableRange = sheet.getRange(HEADER_ROW, COL_FOR_WHO, numRows + 1, width);
  tableRange.setBorder(true, true, true, true, true, true, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);

  // Bandes alternées sur B:C et E:H uniquement : la colonne D (Tracking) garde
  // son propre surlignage (vert = numéro confirmé, sans fond = lien de suivi manuel).
  [
    sheet.getRange(DATA_START_ROW, COL_FOR_WHO, numRows, COL_WHEN - COL_FOR_WHO + 1),
    sheet.getRange(DATA_START_ROW, COL_STATUS, numRows, COL_CARRIER - COL_STATUS + 1)
  ].forEach(function (range) {
    range.getBandings().forEach(function (b) { b.remove(); });
    range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  });

  restoreTrackingHighlight(sheet);
}

function restoreTrackingHighlight(sheet) {
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - DATA_START_ROW + 1;
  if (numRows < 1) return;

  var range = sheet.getRange(DATA_START_ROW, COL_TRACKING, numRows, 1);
  var richValues = range.getRichTextValues();
  var backgrounds = richValues.map(function (row) {
    var rt = row[0];
    var hasLink = rt && rt.getLinkUrl && rt.getLinkUrl();
    return [hasLink ? null : '#6aa84f'];
  });
  range.setBackgrounds(backgrounds);
}

// ---- Menu Google Sheet ("bouton" d'actualisation manuelle) ----

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Suivi colis')
    .addItem('Actualiser maintenant', 'refreshNow')
    .addToUi();
}

function refreshNow() {
  var addedCount = runTrackingSync();
  var message = addedCount > 0
    ? addedCount + ' nouveau(x) numéro(s) de suivi ajouté(s).'
    : 'Aucun nouveau numéro de suivi trouvé.';
  SpreadsheetApp.getUi().alert('Actualisation terminée', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function ensureCarrierColumn(sheet) {
  var header = sheet.getRange(HEADER_ROW, COL_CARRIER).getValue();
  if (!header) {
    sheet.getRange(HEADER_ROW, COL_CARRIER).setValue('Transporteur');
  }
}

function ensureMonthColumn(sheet) {
  var header = sheet.getRange(HEADER_ROW, COL_MONTH).getValue();
  if (!header) {
    sheet.getRange(HEADER_ROW, COL_MONTH).setValue('Mois');
  }
}

function getMonthLabel(date) {
  if (!(date instanceof Date)) return '';
  return MONTHS_FR[date.getMonth()] + ' ' + date.getFullYear();
}

function getExistingTrackingNumbers(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return [];
  var values = sheet.getRange(DATA_START_ROW, COL_TRACKING, lastRow - DATA_START_ROW + 1, 1).getValues();
  return values.map(function (row) { return String(row[0]).trim(); }).filter(String);
}

function appendTrackingRow(sheet, carrierName, forWho, tracking, emailDate) {
  var lastRow = Math.max(sheet.getLastRow(), HEADER_ROW);
  var newRow = lastRow + 1;
  sheet.getRange(newRow, COL_FOR_WHO).setValue(forWho);
  sheet.getRange(newRow, COL_WHEN).setValue(Utilities.formatDate(emailDate, Session.getScriptTimeZone(), 'dd/MM/yyyy'));
  sheet.getRange(newRow, COL_TRACKING).setValue(tracking);
  sheet.getRange(newRow, COL_CARRIER).setValue(carrierName);
  sheet.getRange(newRow, COL_MONTH).setValue(getMonthLabel(emailDate));
}

function getOrCreateLabel(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
  }
  return label;
}

// ---- Parseurs spécifiques à chaque transporteur ----

function extractTNT(message) {
  var subject = message.getSubject();
  var body = message.getPlainBody();

  var trackingMatch = subject.match(/n[°o]\s*(\d+)/i) || body.match(/num[ée]ro d'exp[ée]dition est\s*\**\s*(\d+)/i);
  var tracking = trackingMatch ? trackingMatch[1] : null;

  var forWhoMatch = body.match(/Destinataire\s*:?\s*\r?\n?\s*([^\r\n]+)/i);
  var forWho = forWhoMatch ? forWhoMatch[1].trim() : '';

  return tracking ? { tracking: tracking, forWho: forWho } : null;
}

function extractCTT(message) {
  var subject = message.getSubject();
  var body = message.getPlainBody();

  var trackingMatch = (subject + ' ' + body).match(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/);
  var tracking = trackingMatch ? trackingMatch[0] : null;

  var forWhoMatch = subject.match(/para\s+(.+?)\s+est[áa] a caminho/i) ||
                     body.match(/para\s+([^,]+?)\s+tem entrega/i);
  var forWho = forWhoMatch ? forWhoMatch[1].trim() : '';

  return tracking ? { tracking: tracking, forWho: forWho } : null;
}

// ---- Installation (à exécuter une seule fois manuellement depuis l'éditeur Apps Script) ----

function createTimeDrivenTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'runTrackingSync') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('runTrackingSync')
    .timeBased()
    .everyMinutes(15)
    .create();
}
