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
var COL_FOR_WHO = 3;  // C - "For who ?"
var COL_WHEN = 4;      // D - "When ?"
var COL_TRACKING = 5;  // E - "Tracking"
var COL_STATUS = 6;    // F - "Delivery status" (décalée pour laisser Tracking en E)
var COL_CARRIER = 8;   // H - "Transporteur" (ajoutée par ce script)
var COL_MONTH = 2;     // B - "Mois"

var MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// Le fichier ne doit contenir QUE 2026 : on borne la recherche Gmail à l'année
// 2026. (Sinon les emails 2025 encore récents seraient ré-ajoutés après la purge,
// puisque leur n° n'est plus dans le Sheet.) À ajuster au passage d'année.
var SEARCH_WINDOW = 'after:2025/12/31 before:2027/01/01';

var CARRIERS = [
  {
    name: 'TNT',
    gmailQuery: 'subject:"prise en compte"',
    extract: extractTNT
  },
  {
    // TNT Portugal ("TNT will become FedEx") : notification d'expédition en
    // portugais, expéditeur shipment@mail.tnt.com, sujet « O seu envio N foi
    // marcado », n° de carta de porte (9+ chiffres). N'était couvert par aucun
    // parseur (ni la requête FR "prise en compte", ni FedEx from:fedex.com/12ch).
    name: 'TNT',
    gmailQuery: 'subject:("foi marcado")',
    extract: extractTntPt
  },
  {
    name: 'CTT',
    gmailQuery: 'subject:(encomenda caminho)',
    extract: extractCTT
  },
    {
          name: 'FedEx',
              gmailQuery: 'from:(fedex.com)',
                  extract: extractFedex
                    }
        // FedEx : requête et parseur à vérifier avec un vrai email de confirmation.
];

function runTrackingSync() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);
  ensureCarrierColumn(sheet);
  ensureMonthColumn(sheet);

  var existingTracking = getExistingTrackingNumbers(sheet);
  var addedCount = 0;

  CARRIERS.forEach(function (carrier) {
    // Anti-doublon = le NUMÉRO DE SUIVI (unique), pas un label de thread.
    // On relit l'historique récent à chaque run : un email arrivé dans un fil
    // déjà vu (ou dont l'extraction avait échoué une fois) n'est donc plus
    // jamais perdu — c'est le correctif de l'ancien bug de label.
    var query = SEARCH_WINDOW + ' ' + carrier.gmailQuery;

    searchAllThreads_(query).forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        var data = carrier.extract(message);
        var trackingValue = data && data.tracking ? String(data.tracking).trim() : '';
        if (trackingValue && existingTracking.indexOf(trackingValue) === -1) {
          appendTrackingRow(sheet, carrier.name, data.forWho || '', trackingValue, message.getDate());
          existingTracking.push(trackingValue);
          addedCount++;
        }
      });
    });
  });

  reorganizeMonthGroups(sheet);
  applyVisualStyle(sheet);

  return addedCount;
}

// Pagine la recherche Gmail pour ne pas être plafonné à 50 fils (indispensable
// au rattrapage d'un backlog). Garde-fou dur pour rester sous la limite de
// temps d'exécution d'Apps Script.
function searchAllThreads_(query) {
  var all = [];
  var pageSize = 100;
  var start = 0;
  while (true) {
    var page = GmailApp.search(query, start, pageSize);
    all = all.concat(page);
    if (page.length < pageSize) break;
    start += pageSize;
    if (start >= 2000) break;
  }
  return all;
}

// ---- Regroupement par mois (cellules fusionnées) + mise en forme ----

function reorganizeMonthGroups(sheet) {
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - DATA_START_ROW + 1;
  if (numRows < 1) return;

  var monthRange = sheet.getRange(DATA_START_ROW, COL_MONTH, numRows, 1);
  monthRange.breakApart();

    sheet.getRange(DATA_START_ROW, COL_MONTH, numRows, COL_CARRIER - COL_MONTH + 1)
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
    var width = COL_CARRIER - COL_MONTH + 1;

    sheet.getRange(HEADER_ROW, COL_MONTH, 1, width)
    .setBackground('#1c4587')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.setFrozenRows(HEADER_ROW);

    var tableRange = sheet.getRange(HEADER_ROW, COL_MONTH, numRows + 1, width);
  tableRange.setBorder(true, true, true, true, true, true, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);

    // Bandes alternées sur C:D et F:H uniquement : la colonne E (Tracking) garde
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

// Maintenance one-shot (lançable depuis l'éditeur) : recorrige la colonne « For who ? » des lignes TNT-PT
// existantes en relisant les emails « foi marcado » avec le parseur de
// référence. Renvoie le nombre corrigé.
function fixTntPtForWho() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);

  // 1) Construire une table n° de suivi -> destinataire à partir des emails TNT-PT.
  var byTracking = {};
  searchAllThreads_(SEARCH_WINDOW + ' subject:("foi marcado")').forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      var data = extractTntPt(message);
      if (data && data.tracking) {
        var t = String(data.tracking).trim();
        // Inclure aussi les trackings sans référence (valeur ''), pour pouvoir
        // nettoyer la pollution « Descrição… » de ces lignes. Une valeur non
        // vide l'emporte si le fil contient plusieurs messages.
        if (!(t in byTracking) || data.forWho) byTracking[t] = data.forWho || '';
      }
    });
  });

  // 2) Mettre à jour la colonne For who des lignes dont le n° est retrouvé.
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return 0;
  var n = lastRow - DATA_START_ROW + 1;
  var trackings = sheet.getRange(DATA_START_ROW, COL_TRACKING, n, 1).getValues();
  var forWho = sheet.getRange(DATA_START_ROW, COL_FOR_WHO, n, 1).getValues();

  var updated = 0;
  for (var i = 0; i < n; i++) {
    var t = String(trackings[i][0]).trim();
    if (byTracking.hasOwnProperty(t)) {
      var nv = byTracking[t];
      var cur = String(forWho[i][0]).trim();
      var isPollution = /^Descri|do\s+envio|COSMETIC\s+BODY/i.test(cur);
      // On ne touche JAMAIS une saisie manuelle : on n'écrit que dans une case
      // vide ou contenant l'ancienne pollution « Descrição… ».
      if (cur === '' || isPollution) {
        if (nv && nv !== cur) { forWho[i][0] = nv; updated++; }
        else if (!nv && isPollution) { forWho[i][0] = ''; updated++; }
      }
    }
  }
  sheet.getRange(DATA_START_ROW, COL_FOR_WHO, n, 1).setValues(forWho);
  Logger.log('Destinataires TNT-PT corrigés : %s', updated);
  return updated;
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

// ---- Parseurs spécifiques à chaque transporteur ----

function extractTNT(message) {
  var subject = message.getSubject();
  var body = message.getPlainBody();

  var trackingMatch = subject.match(/n[°o]\s*(\d+)/i) || body.match(/num[ée]ro d'exp[ée]dition est\s*\**\s*(\d+)/i);
  var tracking = trackingMatch ? trackingMatch[1] : null;

        var refMatch = body.match(/R[ée]f[ée]rence[^:\r\n]*:\s*([^\r\n]*)/i);
      var forWhoMatch = body.match(/Destinataire\s*:?\s*\r?\n?\s*([^\r\n]+)/i);
        var forWho = refMatch ? refMatch[1].trim() : (forWhoMatch ? forWhoMatch[1].trim() : '');

  return tracking ? { tracking: tracking, forWho: forWho } : null;
}

function extractCTT(message) {
  var subject = message.getSubject();
  var body = message.getPlainBody();

  var trackingMatch = (subject + ' ' + body).match(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/);
  var tracking = trackingMatch ? trackingMatch[0] : null;

    var refMatch = body.match(/Refer[êe]ncia(?:\s+do\s+cliente)?\s*:?\s*\r?\n?\s*([^\r\n]+)/i);
    var forWhoMatch = subject.match(/para\s+(.+?)\s+est[áa] a caminho/i) ||
                     body.match(/para\s+([^,]+?)\s+tem entrega/i);
    var forWho = refMatch ? refMatch[1].trim() : (forWhoMatch ? forWhoMatch[1].trim() : '');

  return tracking ? { tracking: tracking, forWho: forWho } : null;
}

function extractFedex(message) {
  var subject = message.getSubject();
    var body = message.getPlainBody();

      var trackingMatch = (subject + ' ' + body).match(/\b\d{12}\b/);
        var tracking = trackingMatch ? trackingMatch[0] : null;

          var refMatch = body.match(/R[ée]f(?:[ée]rence)?\s*:?\s*\r?\n?\s*([^\r\n]+)/i);
            var forWho = refMatch ? refMatch[1].trim() : '';

              return tracking ? { tracking: tracking, forWho: forWho } : null;
              }

function extractTntPt(message) {
  var subject = message.getSubject();
  var body = message.getPlainBody();

  // Sujet : « O seu envio 154063029 foi marcado ». Fallback corps : « CARTA DE PORTE 154063029 ».
  var trackingMatch = subject.match(/envio\s+(\d{6,})\s+foi\s+marcado/i)
                   || body.match(/CARTA\s+DE\s+PORTE\s*[:#-]?\s*(\d{6,})/i);
  var tracking = trackingMatch ? trackingMatch[1] : null;

  // « For who ? » = la RÉFÉRENCE de l'envoi (ex. « #2218 », « Sunstudio »),
  // PAS le nom du destinataire. Elle figure en « Referência do envio: <valeur> ».
  // Dans certains emails la valeur est vide dans le texte brut (présente
  // uniquement dans le HTML) : on capture jusqu'à « Descrição »/fin de ligne,
  // puis on se rabat sur le corps HTML (balises retirées) si besoin.
  var forWho = refFromTntPt_(body);
  if (!forWho) forWho = refFromTntPt_(String(message.getBody() || '').replace(/<[^>]+>/g, ' '));

  return tracking ? { tracking: tracking, forWho: forWho } : null;
}

function refFromTntPt_(text) {
  // Gère « Referência do envio: » ET « Referência do cliente: » (et « Referência: »
  // seul). Capture non gourmande, stoppée à « Descrição »/fin de ligne pour ne pas
  // déborder quand la valeur est vide dans le texte brut.
  var m = text.match(/Refer[êe]ncia(?:\s+do\s+(?:envio|cliente))?\s*:\s*(.*?)\s*(?:Descri|[\r\n]|$)/i);
  return m ? m[1].trim() : '';
}

// ---- Maintenance : ne garder que l'année 2026 ----

// Année de l'objet Date OU d'une chaîne "dd/MM/yyyy" ; null si illisible.
function yearOfWhen_(v) {
  if (v instanceof Date) return v.getFullYear();
  var m = String(v).match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

// APERÇU (ne supprime rien) : journalise la répartition des lignes par année.
function previewYears() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) { Logger.log('Aucune ligne de données.'); return {}; }
  var n = lastRow - DATA_START_ROW + 1;
  var whenVals = sheet.getRange(DATA_START_ROW, COL_WHEN, n, 1).getValues();
  var counts = {};
  whenVals.forEach(function (r) {
    var y = yearOfWhen_(r[0]);
    var key = (y === null) ? 'illisible' : String(y);
    counts[key] = (counts[key] || 0) + 1;
  });
  Logger.log('Répartition par année : %s', JSON.stringify(counts));
  return counts;
}

// SUPPRIME les lignes dont l'année est un nombre valide ≠ 2026.
// Les lignes sans date lisible sont PRÉSERVÉES. Renvoie le nombre supprimé.
function deleteRowsNot2026() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return 0;
  var n = lastRow - DATA_START_ROW + 1;
  var whenVals = sheet.getRange(DATA_START_ROW, COL_WHEN, n, 1).getValues();

  var toDelete = [];
  for (var i = 0; i < n; i++) {
    var y = yearOfWhen_(whenVals[i][0]);
    if (y !== null && y !== 2026) toDelete.push(DATA_START_ROW + i);
  }

  // Défusionner la colonne Mois avant de supprimer, sinon les fusions gênent.
  sheet.getRange(DATA_START_ROW, COL_MONTH, n, 1).breakApart();
  for (var j = toDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(toDelete[j]);
  }

  reorganizeMonthGroups(sheet);
  applyVisualStyle(sheet);
  Logger.log('%s ligne(s) supprimée(s) (année ≠ 2026).', toDelete.length);
  return toDelete.length;
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
