# Setup: Toconline → Google Sheet stock sync

One-time setup, done once in the Google Sheets / Apps Script UI. Nothing here needs your Mac to stay on afterwards — once the trigger is installed, it runs on Google's servers.

## 0. Convert the sheet to native Google Sheets format — DONE

Converted: https://docs.google.com/spreadsheets/d/1EwRQg-r2Y1F5SinmeJNE47iA9Opdm19QcGJprWQNIXs/edit

This spreadsheet has multiple tabs. **`Code.gs` targets the "STOCK 26" tab** (columns A=PRODUCT, B=BATCH, month blocks starting column H with SOLD/GIFTED/TESTER/BROKEN, JUNE→DECEMBER) — confirmed with the user. The other tab ("STOCK Jan- June 2026") is not touched by this script.

## 1. Open the Apps Script editor

From this Sheet: **Extensions > Apps Script**. Delete the default empty `Code.gs` content and paste in the contents of `Code.gs` from this folder.

## 2. Add the OAuth2 library

In the Apps Script editor: **Libraries (+)** next to "Files" > paste this script ID:

```
1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
```

> Look up the latest version number the picker shows and select it, identifier `OAuth2`.

## 3. Set Script Properties (your Toconline credentials)

In the Apps Script editor: **Project Settings (gear icon) > Script Properties > Add script property**. Add these four (values from Toconline: Company > Settings > API Data):

| Property | Value |
|---|---|
| `TOCONLINE_CLIENT_ID` | your client_id |
| `TOCONLINE_SECRET` | your secret |
| `TOCONLINE_OAUTH_URL` | the OAuth base URL shown on that page |
| `TOCONLINE_API_URL` | the API base URL shown on that page |

These are entered directly in Google's UI — they never need to be pasted into chat.

## 4. Deploy as a Web App (needed once, for the OAuth callback)

1. **Deploy > New deployment > Web app**.
2. Execute as: **Me**. Who has access: **Only myself**.
3. Deploy, copy the Web App URL it gives you.
4. **Important, and non-obvious**: Toconline's registered redirect_uri must NOT be this `/exec` Web App URL. The OAuth2 library actually sends a different, stable callback URL of the form `https://script.google.com/macros/d/{SCRIPT_ID}/usercallback` (visible in the `authorize()` log output). Register **that** URL in Toconline's "Endereço URI de redirect" field instead — this one doesn't change across redeployments, so it only needs to be set once.

## 5. Authorize Toconline (one time)

1. In the Apps Script editor, select the function `authorize` (dropdown near Run) and click **Run**.
2. Approve the Apps Script permissions prompt (it needs to read/write this spreadsheet and make external requests).
3. Open **Executions**, copy the authorization URL it logged, open it in your browser, and log into Toconline to grant access.
4. You should land on a page saying "Success! Toconline is authorized."

## 6. Test manually before automating

1. Run the function `syncStock` from the editor.
2. Check the **Sync Log** tab (auto-created) for what it updated and anything unmatched.
3. Spot-check the current month's SOLD column against 2-3 real July invoices.
4. Fix any unmatched product names (likely just naming differences between Toconline and the sheet — tell me what shows up and I'll adjust `normalizeProductName_` in `Code.gs`).

Note on multi-batch products: when a product has more than one BATCH row, the script picks the row where **STOCK LEFT > 0** as the active one. If more than one batch row has stock left for the same product, it's left unmatched (logged) rather than guessed.

## 7. Turn on the 10-minute automation

Once step 6 looks correct: run the function `installTrigger` once from the editor. From then on, `syncStock` runs automatically every 10 minutes, independent of your Mac.

To stop it later, run `removeExistingTriggers_` (or delete the trigger from the clock icon in the Apps Script editor sidebar).
