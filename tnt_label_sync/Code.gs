/**
 * Ofa Karri - Génération automatique des étiquettes TNT/FedEx depuis Shopify
 *
 * Objectif : supprimer la double saisie. Le script lit les commandes Shopify
 * NON EXPÉDIÉES, construit l'étiquette via l'API FedEx (service + poids fixes,
 * seule l'adresse du destinataire change), récupère le PDF + le numéro de
 * suivi, enregistre le PDF dans Drive et journalise dans un Sheet.
 *
 * ⚠️ SQUELETTE - à finaliser après obtention des identifiants API et test en
 *    SANDBOX. Les codes exacts serviceType / packagingType / labelStockType
 *    dépendent de TON contrat FedEx/TNT : à confirmer dans le sandbox (voir
 *    SETUP.md). Rien n'est écrit tant que DRY_RUN = true.
 *
 * Identifiants : JAMAIS en clair. Dans Projet > Paramètres > Script Properties :
 *   - FEDEX_CLIENT_ID       (clé API)
 *   - FEDEX_CLIENT_SECRET   (secret API)
 *   - FEDEX_ACCOUNT_NUMBER  (numéro de compte FedEx/TNT)
 *   - SHOPIFY_ADMIN_TOKEN   (déjà utilisé par shopify_fulfillment_sync)
 *
 * Boucle fermée : une fois l'étiquette créée, on a déjà le numéro de suivi.
 * La remontée vers Shopify (fulfillment + notif client) est déjà codée dans
 * le module `shopify_fulfillment_sync` (createFulfillment_). Voir pushTrackingToShopify_.
 */

// ======================= INTERRUPTEURS =======================
var DRY_RUN = true;          // true = simulation : logue la requête, N'APPELLE PAS FedEx
var FEDEX_ENV = 'sandbox';   // 'sandbox' (tests) ou 'production'
var RUN_FEDEX_TEST = true;   // TEMP : true = teste FedEx avec une fausse adresse au lancement, puis stop. Remettre false ensuite.

// Boucle fermée Shopify : remonter le tracking -> commande "Fulfilled" + notif client.
var CLOSE_LOOP = false;            // true = crée le fulfillment Shopify après l'étiquette (opt-in)
var NOTIFY_CUSTOMER = false;       // true = Shopify envoie l'email d'expédition au client (si CLOSE_LOOP)
var FULFILLMENT_CARRIER = 'FedEx'; // société transmise à Shopify (Shopify génère l'URL de suivi)

// ======================= COLIS STANDARD (fixe) =======================
// Confirmés par l'utilisateur : service et poids toujours identiques.
// ⚠️ Codes à valider dans le sandbox FedEx selon ton contrat.
var SERVICE_TYPE = 'FEDEX_INTERNATIONAL_PRIORITY'; // TODO: confirmer le code exact du service TNT/FedEx utilisé
var PACKAGING_TYPE = 'YOUR_PACKAGING';             // ex. 'YOUR_PACKAGING' (ton propre emballage)
var PICKUP_TYPE = 'USE_SCHEDULED_PICKUP';          // ou 'DROPOFF_AT_FEDEX_LOCATION' selon ton fonctionnement
var WEIGHT_KG = 0.5;                               // poids standard confirmé (0,5 kg)
var LABEL_IMAGE_TYPE = 'PDF';
var LABEL_STOCK_TYPE = 'PAPER_85X11_TOP_HALF_LABEL'; // TODO: adapter au format d'impression

// ======================= DOUANE (champ requis par l'API) =======================
// FedEx exige customsClearanceDetail dès que le colis franchit une frontière,
// même en intra-UE (PT -> UE). Intra-UE = 0 droit à payer, mais le champ doit
// être présent sinon HTTP 400 CUSTOMSCLEARANCEDETAIL.REQUIRED.
// Produits homogènes -> valeurs fixes. La valeur déclarée vient du total de la
// commande Shopify (valeur de repli DEFAULT_CUSTOMS_VALUE pour le test fictif).
var COMMODITY_DESCRIPTION = 'COSMETIC BODY OIL';
var COUNTRY_OF_MANUFACTURE = 'FR';   // pays d'origine/fabrication
var CUSTOMS_CURRENCY = 'EUR';        // devise de repli si absente de la commande
var DEFAULT_CUSTOMS_VALUE = 25;      // valeur déclarée de repli (test sandbox)

// ======================= EXPÉDITEUR (fixe) =======================
// Repris du carnet myTNT (Expedidor OFA KARRI LDA).
var SHIPPER = {
  personName: 'OFA KARRI',
  companyName: 'OFA KARRI LDA',
  phone: '913939888',              // tél. expéditeur OFA KARRI (PT +351)
  email: 'bonjour@ofakarri.com',
  streetLines: ['RUA DOM LUIS I, 19, 5 AND'],
  city: 'Lisboa',
  postalCode: '1200-149',
  countryCode: 'PT'
};

// ======================= SHOPIFY =======================
var SHOP_DOMAIN = 'ofa-karri-osmp.myshopify.com';
var SHOPIFY_API_VERSION = '2026-07';
var ORDERS_LOOKBACK_DAYS = 30;   // fenêtre de balayage. Note : read_orders ne voit que ~60 j max de toute façon.
var MAX_ORDERS_PER_RUN = 25;
var DEDUP_TAG = 'etiquette-creee';   // anti-doublon : tag posé sur la commande une fois l'étiquette créée

// ======================= SORTIE (Drive + journal) =======================
var DRIVE_FOLDER_NAME = 'Etiquettes TNT';   // dossier Drive où déposer les PDF
var LOG_SPREADSHEET_ID = '';                // TODO: ID du Sheet de journal (laisser vide = pas de log Sheet)
var LOG_TAB = 'TNT Label Log';

// ======================= ENDPOINTS FedEx =======================
function fedexBaseUrl_() {
  return FEDEX_ENV === 'production'
    ? 'https://apis.fedex.com'
    : 'https://apis-sandbox.fedex.com';
}

// =====================================================================
// POINT D'ENTRÉE
// =====================================================================

/**
 * Traite les commandes Shopify non expédiées : crée une étiquette pour chacune.
 * Lancer à la main depuis l'éditeur, ou via un déclencheur temporel.
 */
function creerEtiquettesNouvellesCommandes() {
  if (RUN_FEDEX_TEST) { testFedexSandbox_(); return; } // TEMP : test FedEx avec fausse adresse

  var token = getShopifyToken_();
  var orders = fetchUnfulfilledOrders_(token);
  Logger.log('%s commande(s) non expédiée(s) à traiter.', orders.length);

  orders.forEach(function (order) {
    try {
      var req = buildShipRequest_(order);

      if (DRY_RUN) {
        Logger.log('[DRY_RUN] Commande %s -> requête FedEx :\n%s',
          order.name, JSON.stringify(req, null, 2));
        return;
      }

      var result = callFedexShip_(req);              // { trackingNumber, labelBase64 }
      var pdfUrl = saveLabelPdf_(order.name, result.labelBase64);
      logRow_(order, result.trackingNumber, pdfUrl);
      Logger.log('Commande %s -> suivi %s, étiquette %s',
        order.name, result.trackingNumber, pdfUrl);

      markOrderLabeled_(token, order);   // anti-doublon : tag pour ne pas ré-étiqueter

      // Boucle fermée : remonter le tracking dans Shopify (Fulfilled + notif client).
      if (CLOSE_LOOP) pushTrackingToShopify_(token, order, result.trackingNumber);
    } catch (e) {
      Logger.log('ERREUR commande %s : %s', order.name, e.message);
    }
  });
}

// =====================================================================
// TEST FedEx : génère une étiquette sandbox avec un destinataire factice
// =====================================================================

function testFedexSandbox_() {
  var fauxOrder = {
    name: '#TEST-SANDBOX',
    email: 'test@example.com',
    totalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'EUR' } },
    shippingAddress: {
      name: 'Jean Test',
      firstName: 'Jean',
      lastName: 'Test',
      company: '',
      phone: '+33600000000',
      address1: '10 Rue de Rivoli',
      address2: '',
      city: 'Paris',
      zip: '75004',
      countryCodeV2: 'FR'
    }
  };

  var req = buildShipRequest_(fauxOrder);
  Logger.log('Requête FedEx envoyée :\n%s', JSON.stringify(req, null, 2));

  try {
    var result = callFedexShip_(req);
    Logger.log('✅ FedEx OK — n° de suivi : %s', result.trackingNumber || '(vide)');
    if (result.labelBase64) {
      var url = saveLabelPdf_('TEST-SANDBOX', result.labelBase64);
      Logger.log('✅ Étiquette PDF enregistrée dans Drive : %s', url);
    } else {
      Logger.log('⚠️ Pas de PDF dans la réponse (à vérifier).');
    }
  } catch (e) {
    Logger.log('❌ FedEx a refusé : %s', e.message);
  }
}

// =====================================================================
// DIAGNOSTIC : affiche les scopes réellement accordés au jeton
// =====================================================================

function diagnoseShopifyScopes() {
  var props = PropertiesService.getScriptProperties();
  var res = UrlFetchApp.fetch('https://' + SHOP_DOMAIN + '/admin/oauth/access_token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: props.getProperty('SHOPIFY_CLIENT_ID'),
      client_secret: props.getProperty('SHOPIFY_CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  Logger.log('HTTP %s — scopes accordés au jeton : "%s" (expire dans %s s)',
    res.getResponseCode(), body.scope, body.expires_in);
}

// =====================================================================
// SHOPIFY : lecture des commandes non expédiées
// =====================================================================

function fetchUnfulfilledOrders_(token) {
  var since = new Date(Date.now() - ORDERS_LOOKBACK_DAYS * 24 * 3600 * 1000);
  var sinceStr = Utilities.formatDate(since, 'Etc/UTC', 'yyyy-MM-dd'); // date seule = format sûr pour la recherche Shopify
  // Anti-doublon : on exclut les commandes déjà étiquetées (tag DEDUP_TAG).
  var q = 'fulfillment_status:unfulfilled AND created_at:>=' + sinceStr +
          ' AND -tag:' + DEDUP_TAG;

  var query = [
    'query($q: String!, $n: Int!) {',
    '  orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) {',
    '    edges { node {',
    '      id name email',
    '      totalPriceSet { shopMoney { amount currencyCode } }',
    '      shippingAddress {',
    '        name firstName lastName company phone',
    '        address1 address2 city zip countryCodeV2',
    '      }',
    '    } }',
    '  }',
    '}'
  ].join('\n');

  var data = shopifyGraphql_(token, query, { q: q, n: MAX_ORDERS_PER_RUN });
  var edges = (((data.orders || {}).edges) || []);
  return edges
    .map(function (e) { return e.node; })
    .filter(function (o) { return o.shippingAddress; });
}

// =====================================================================
// FedEx : construction de la requête d'étiquette
// =====================================================================

function buildShipRequest_(order) {
  var a = order.shippingAddress;
  var accountNumber = getFedexAccount_();

  // Valeur déclarée = total payé de la commande Shopify (repli si absent).
  var money = (order.totalPriceSet && order.totalPriceSet.shopMoney) || {};
  var customsValue = Number(money.amount) || DEFAULT_CUSTOMS_VALUE;
  var customsCurrency = money.currencyCode || CUSTOMS_CURRENCY;

  var recipient = {
    contact: {
      personName: a.name || ((a.firstName || '') + ' ' + (a.lastName || '')).trim(),
      phoneNumber: a.phone || '',
      companyName: a.company || ''
    },
    address: {
      streetLines: [a.address1, a.address2].filter(function (s) { return s; }),
      city: a.city || '',
      postalCode: a.zip || '',
      countryCode: a.countryCodeV2 || ''
    }
  };

  return {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: accountNumber },
    requestedShipment: {
      shipDatestamp: Utilities.formatDate(new Date(), 'Europe/Lisbon', 'yyyy-MM-dd'),
      pickupType: PICKUP_TYPE,
      serviceType: SERVICE_TYPE,
      packagingType: PACKAGING_TYPE,
      shipper: {
        contact: {
          personName: SHIPPER.personName,
          phoneNumber: SHIPPER.phone,
          companyName: SHIPPER.companyName
        },
        address: {
          streetLines: SHIPPER.streetLines,
          city: SHIPPER.city,
          postalCode: SHIPPER.postalCode,
          countryCode: SHIPPER.countryCode
        }
      },
      recipients: [recipient],
      shippingChargesPayment: {
        paymentType: 'SENDER',
        payor: { responsibleParty: { accountNumber: { value: accountNumber } } }
      },
      customsClearanceDetail: {
        dutiesPayment: {
          paymentType: 'SENDER',
          payor: { responsibleParty: { accountNumber: { value: accountNumber } } }
        },
        commodities: [
          {
            description: COMMODITY_DESCRIPTION,
            countryOfManufacture: COUNTRY_OF_MANUFACTURE,
            quantity: 1,
            quantityUnits: 'PCS',
            weight: { units: 'KG', value: WEIGHT_KG },
            customsValue: { amount: customsValue, currency: customsCurrency }
          }
        ]
      },
      labelSpecification: {
        imageType: LABEL_IMAGE_TYPE,
        labelStockType: LABEL_STOCK_TYPE
      },
      requestedPackageLineItems: [
        { weight: { units: 'KG', value: WEIGHT_KG } }
      ]
    }
  };
}

// =====================================================================
// FedEx : appels API (auth + création)
// =====================================================================

function getFedexToken_() {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('FEDEX_CLIENT_ID');
  var clientSecret = props.getProperty('FEDEX_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('FEDEX_CLIENT_ID / FEDEX_CLIENT_SECRET manquants (Script Properties). Voir SETUP.md.');
  }

  var response = UrlFetchApp.fetch(fedexBaseUrl_() + '/oauth/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) {
    throw new Error('FedEx OAuth HTTP ' + code + ' : ' + text);
  }
  return JSON.parse(text).access_token; // valable ~1h
}

function getFedexAccount_() {
  var acc = PropertiesService.getScriptProperties().getProperty('FEDEX_ACCOUNT_NUMBER');
  if (!acc) {
    throw new Error('FEDEX_ACCOUNT_NUMBER manquant (Script Properties). Voir SETUP.md.');
  }
  return acc;
}

/**
 * Appelle POST /ship/v1/shipments et extrait le tracking + le PDF (base64).
 * ⚠️ Le chemin d'extraction ci-dessous suit la structure FedEx standard mais
 *    DOIT être vérifié sur une vraie réponse sandbox (les clés peuvent varier
 *    selon la version d'API activée sur ton compte).
 */
function callFedexShip_(shipRequest) {
  var accessToken = getFedexToken_();
  var response = UrlFetchApp.fetch(fedexBaseUrl_() + '/ship/v1/shipments', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'X-locale': 'pt_PT'
    },
    payload: JSON.stringify(shipRequest),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) {
    throw new Error('FedEx Ship HTTP ' + code + ' : ' + text);
  }

  var body = JSON.parse(text);
  var shipment = (((body.output || {}).transactionShipments) || [])[0] || {};
  var piece = ((shipment.pieceResponses) || [])[0] || {};
  var doc = ((piece.packageDocuments) || [])[0] || {};

  return {
    trackingNumber: piece.trackingNumber || shipment.masterTrackingNumber || '',
    labelBase64: doc.encodedLabel || ''  // PDF encodé en base64
  };
}

// =====================================================================
// SORTIE : PDF dans Drive + ligne de journal
// =====================================================================

function saveLabelPdf_(orderName, labelBase64) {
  if (!labelBase64) throw new Error('Étiquette vide renvoyée par FedEx.');
  var folder = getOrCreateFolder_(DRIVE_FOLDER_NAME);
  var bytes = Utilities.base64Decode(labelBase64);
  var blob = Utilities.newBlob(bytes, 'application/pdf', 'TNT_' + orderName + '.pdf');
  var file = folder.createFile(blob);
  return file.getUrl();
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function logRow_(order, trackingNumber, pdfUrl) {
  if (!LOG_SPREADSHEET_ID) return;
  var ss = SpreadsheetApp.openById(LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LOG_TAB) || ss.insertSheet(LOG_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date', 'Commande', 'Destinataire', 'Suivi', 'PDF']);
  }
  var a = order.shippingAddress || {};
  sheet.appendRow([new Date(), order.name, a.name || '', trackingNumber, pdfUrl]);
}

// =====================================================================
// ANTI-DOUBLON : tag la commande une fois l'étiquette créée
// =====================================================================

/**
 * Pose le tag DEDUP_TAG sur la commande pour qu'elle ne ressorte plus dans
 * fetchUnfulfilledOrders_ (filtre -tag:). Nécessite le scope Shopify
 * `write_orders`. En cas d'échec, on LOGUE en clair sans planter : l'étiquette
 * est déjà émise, il faut alors taguer la commande à la main, sinon elle sera
 * ré-étiquetée au prochain passage.
 */
function markOrderLabeled_(token, order) {
  var mutation = [
    'mutation($id: ID!, $tags: [String!]!) {',
    '  tagsAdd(id: $id, tags: $tags) {',
    '    userErrors { field message }',
    '  }',
    '}'
  ].join('\n');

  try {
    var data = shopifyGraphql_(token, mutation, { id: order.id, tags: [DEDUP_TAG] });
    var errs = ((data.tagsAdd || {}).userErrors) || [];
    if (errs.length) {
      Logger.log('⚠️ ANTI-DOUBLON : tag NON posé sur %s : %s — TAGUER À LA MAIN sinon ré-étiquetage.',
        order.name, JSON.stringify(errs));
    }
  } catch (e) {
    Logger.log('⚠️ ANTI-DOUBLON : échec du tag sur %s : %s — TAGUER À LA MAIN sinon ré-étiquetage.',
      order.name, e.message);
  }
}

// =====================================================================
// BOUCLE FERMÉE : remonter le tracking FedEx vers Shopify (Fulfilled + notif)
// =====================================================================

/**
 * Crée le fulfillment Shopify avec le numéro de suivi FedEx : la commande
 * passe en "Fulfilled" et, si NOTIFY_CUSTOMER = true, Shopify envoie au client
 * son email d'expédition. Même logique que createFulfillment_ du module
 * shopify_fulfillment_sync, mais on part de l'order.id (on résout ici son
 * fulfillmentOrder ouvert).
 *
 * Scope requis : `write_merchant_managed_fulfillment_orders`.
 * En cas d'échec, on LOGUE sans planter (l'étiquette + le tracking existent
 * déjà ; le fulfillment pourra être refait à la main dans Shopify).
 */
function pushTrackingToShopify_(token, order, trackingNumber) {
  if (!trackingNumber) {
    Logger.log('⚠️ BOUCLE SHOPIFY : pas de tracking pour %s — fulfillment ignoré.', order.name);
    return;
  }

  try {
    // 1) Trouver le fulfillmentOrder OPEN de la commande.
    var foQuery = [
      'query($id: ID!) {',
      '  order(id: $id) {',
      '    fulfillmentOrders(first: 10) { edges { node { id status } } }',
      '  }',
      '}'
    ].join('\n');
    var foData = shopifyGraphql_(token, foQuery, { id: order.id });
    var foEdges = ((((foData.order || {}).fulfillmentOrders) || {}).edges) || [];
    var openFo = foEdges
      .map(function (e) { return e.node; })
      .filter(function (fo) { return fo.status === 'OPEN'; })[0];

    if (!openFo) {
      Logger.log('⚠️ BOUCLE SHOPIFY : aucun fulfillmentOrder OPEN pour %s — fulfillment non créé.', order.name);
      return;
    }

    // 2) Créer le fulfillment avec le tracking FedEx.
    var mutation = [
      'mutation($fulfillment: FulfillmentInput!) {',
      '  fulfillmentCreate(fulfillment: $fulfillment) {',
      '    fulfillment { id status }',
      '    userErrors { field message }',
      '  }',
      '}'
    ].join('\n');
    var variables = {
      fulfillment: {
        notifyCustomer: NOTIFY_CUSTOMER,
        trackingInfo: { company: FULFILLMENT_CARRIER, number: trackingNumber },
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFo.id }]
      }
    };

    var data = shopifyGraphql_(token, mutation, variables);
    var out = data.fulfillmentCreate || {};
    var errs = out.userErrors || [];
    if (errs.length) {
      Logger.log('⚠️ BOUCLE SHOPIFY : fulfillmentCreate a échoué pour %s : %s',
        order.name, JSON.stringify(errs));
      return;
    }
    Logger.log('Boucle Shopify : %s -> Fulfilled (tracking %s, notif client = %s)',
      order.name, trackingNumber, NOTIFY_CUSTOMER);
  } catch (e) {
    Logger.log('⚠️ BOUCLE SHOPIFY : erreur pour %s : %s', order.name, e.message);
  }
}

// =====================================================================
// SHOPIFY : client GraphQL (repris de shopify_fulfillment_sync)
// =====================================================================

/**
 * Obtient un jeton d'accès Admin API via le "client credentials grant".
 * L'app du Dev Dashboard agit sur notre propre boutique : on échange
 * Client ID + Secret contre un jeton (valable 24h), à chaque exécution.
 * Prérequis : l'app doit avoir une VERSION publiée avec le scope read_orders,
 * et être installée sur la boutique (même organisation Dev Dashboard).
 */
function getShopifyToken_() {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('SHOPIFY_CLIENT_ID');
  var clientSecret = props.getProperty('SHOPIFY_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET manquants (Script Properties). Voir SETUP.md.');
  }

  var response = UrlFetchApp.fetch('https://' + SHOP_DOMAIN + '/admin/oauth/access_token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) {
    throw new Error('Shopify OAuth HTTP ' + code + ' : ' + text);
  }
  return JSON.parse(text).access_token; // valable ~24h
}

function shopifyGraphql_(token, query, variables) {
  var url = 'https://' + SHOP_DOMAIN + '/admin/api/' + SHOPIFY_API_VERSION + '/graphql.json';
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code !== 200) throw new Error('Shopify HTTP ' + code + ' : ' + text);
  var body = JSON.parse(text);
  if (body.errors) throw new Error('Shopify GraphQL errors : ' + JSON.stringify(body.errors));
  return body.data;
}
