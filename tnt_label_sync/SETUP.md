# tnt_label_sync — installation

Génère automatiquement les étiquettes **TNT / FedEx** à partir des commandes
Shopify non expédiées, sans ressaisie. Service et poids sont **fixes** (produits
homogènes) ; seule l'adresse du destinataire change et vient de Shopify.

> ⚠️ **Statut : squelette.** À finaliser après obtention des identifiants API et
> test en **sandbox**. Rien n'est appelé/écrit tant que `DRY_RUN = true`.

---

## 0. Pré-requis côté transporteur (le vrai blocage)

TNT bascule vers **FedEx** (« TNT will become FedEx »). Il faut savoir à quelle
API ton compte a droit et obtenir les accès. À demander à ton contact TNT/FedEx
ou dans l'espace pro :

1. Mon compte peut-il émettre des étiquettes via **API** ? Laquelle : **FedEx
   Ship API** (cible recommandée) ou **TNT ExpressConnect** (hérité) ?
2. Obtenir : **API Key** (client_id), **Secret** (client_secret), **numéro de
   compte** FedEx/TNT.
3. Accès **sandbox** pour tester sans émettre de vraie étiquette.

Ce squelette vise la **FedEx Ship API** (REST). Si ton compte est sur TNT
ExpressConnect (XML), l'auth et le format de requête seront différents — dis-le
moi et j'adapte.

## 1. Créer / réutiliser l'app Shopify (lecture des commandes)

Le jeton `SHOPIFY_ADMIN_TOKEN` existe déjà (module `shopify_fulfillment_sync`).
Scope nécessaire ici : **`read_orders`** (déjà accordé). Rien à refaire si tu
réutilises le même jeton.

## 2. Créer le projet Apps Script et pousser le code

```bash
cd tnt_label_sync
clasp create --type standalone --title "Ofa Karri - TNT Label Sync"
clasp push
```

## 3. Renseigner les identifiants (Script Properties)

Éditeur Apps Script : **Paramètres du projet (⚙️) → Propriétés du script**. Les
identifiants ne sont **jamais** dans le code.

| Propriété               | Valeur                               |
|-------------------------|--------------------------------------|
| `FEDEX_CLIENT_ID`       | clé API FedEx                        |
| `FEDEX_CLIENT_SECRET`   | secret API FedEx                     |
| `FEDEX_ACCOUNT_NUMBER`  | numéro de compte FedEx/TNT           |
| `SHOPIFY_ADMIN_TOKEN`   | `shpat_...` (le même que l'autre module) |

## 4. Régler le colis standard (dans `Code.gs`)

En haut du fichier, adapter les constantes à **ton** contrat (valeurs à
confirmer dans le sandbox) :

```js
var SERVICE_TYPE    = 'FEDEX_INTERNATIONAL_PRIORITY'; // ton service réel (à confirmer via myTNT « Selecionar modelo »)
var PACKAGING_TYPE  = 'YOUR_PACKAGING';               // ton emballage (myTNT « Caixa » = ton carton)
var PICKUP_TYPE     = 'USE_SCHEDULED_PICKUP';         // ou DROPOFF_AT_FEDEX_LOCATION
var WEIGHT_KG       = 0.5;                            // ton poids réel
var BOX_LENGTH_CM   = 20;                             // carton standard L × l × H (obligatoire chez myTNT)
var BOX_WIDTH_CM    = 15;
var BOX_HEIGHT_CM   = 10;
var LABEL_STOCK_TYPE = 'PAPER_85X11_TOP_HALF_LABEL';  // format d'impression (STOCK_4X6 si imprimante thermique)
```

Le **n° de commande Shopify** (`order.name`) est envoyé comme référence client
FedEx (`customerReferences` → `CUSTOMER_REFERENCE`), équivalent du champ
« Referência do cliente » de myTNT.

Vérifier aussi l'expéditeur `SHIPPER` (numéro de téléphone à compléter).

## 5. Déploiement par paliers (IMPORTANT)

`var DRY_RUN = true;` et `var FEDEX_ENV = 'sandbox';` en haut de `Code.gs`.

**Palier 1 — Simulation** (`DRY_RUN = true`)
- Exécuter `creerEtiquettesNouvellesCommandes` depuis l'éditeur, autoriser les accès.
- Lire les logs (Exécutions) : pour chaque commande, la **requête FedEx complète**
  est affichée. Vérifier que l'adresse destinataire est correcte.

**Palier 2 — Sandbox réel** (`DRY_RUN = false`, `FEDEX_ENV = 'sandbox'`)
- `clasp push`, relancer. L'API sandbox renvoie une **vraie réponse** (PDF de
  test + tracking factice). Vérifier :
  - le PDF déposé dans le dossier Drive `Etiquettes TNT` ;
  - que les clés d'extraction dans `callFedexShip_` correspondent bien à la
    réponse réelle (`transactionShipments` / `pieceResponses` / `packageDocuments`).

**Palier 3 — Production** (`FEDEX_ENV = 'production'`)
- `clasp push`. Les étiquettes émises sont désormais réelles et facturées.

## 6. Automatiser (plus tard)

Une fois le palier 3 validé, ajouter un déclencheur temporel sur
`creerEtiquettesNouvellesCommandes` (ex. toutes les 30 min). À faire seulement
quand tu es sûr du résultat — une étiquette de prod = un coût.

---

## Boucle fermée avec Shopify (implémentée, opt-in)

L'étiquette créée fournit déjà le **numéro de suivi**. `pushTrackingToShopify_`
crée le fulfillment Shopify → la commande passe en *Fulfilled* et, si activé,
Shopify envoie au client son email d'expédition. Même logique `fulfillmentCreate`
que le module `shopify_fulfillment_sync`.

Interrupteurs en haut de `Code.gs` :

```js
var CLOSE_LOOP = false;            // true = crée le fulfillment après l'étiquette
var NOTIFY_CUSTOMER = false;       // true = email d'expédition envoyé au client
var FULFILLMENT_CARRIER = 'FedEx'; // société transmise à Shopify
```

⚠️ **Scope requis : `write_merchant_managed_fulfillment_orders`.** À activer par
paliers : d'abord `CLOSE_LOOP = true` avec `NOTIFY_CUSTOMER = false` (vérifier
dans l'admin Shopify que les bonnes commandes passent *Fulfilled* avec le bon
n°), puis `NOTIFY_CUSTOMER = true`. En cas d'échec, le log affiche
`⚠️ BOUCLE SHOPIFY : ...` sans bloquer (l'étiquette est déjà émise).

✅ **Domaine Shopify confirmé** : ce module cible `ofa-karri-osmp.myshopify.com`,
qui est bien le `myshopifyDomain` réel de la boutique OFA KARRI (domaine public
`www.ofakarri.com`) — vérifié via l'Admin API le 2026-09-10 (commande #2243
présente). La boucle fermée pointe donc sur la bonne boutique.

ℹ️ À part : `shopify_fulfillment_sync` utilise `ofakarri.myshopify.com` dans sa
copie locale, qui ne correspond PAS au `myshopifyDomain` réel — à vérifier
séparément (possible drift prod ↔ dépôt), sans rapport avec ce module.

## Anti-doublon (implémenté)

Garde-fou par **tag Shopify** : après création réussie de l'étiquette, la
commande reçoit le tag `etiquette-creee` (`markOrderLabeled_`). La requête qui
liste les commandes non expédiées exclut ce tag (`-tag:etiquette-creee`), donc
une commande déjà étiquetée ne repasse jamais.

⚠️ **Scope requis : `write_orders`** (en plus de `read_orders`). À ajouter à
l'app Shopify (Dev Dashboard) et republier une version, sinon le tag échoue :
dans ce cas le log affiche `⚠️ ANTI-DOUBLON : ...` et la commande devra être
taguée à la main pour éviter un ré-étiquetage. L'étiquette, elle, est déjà émise.

Le nom du tag est réglable via `var DEDUP_TAG` en haut de `Code.gs`.
