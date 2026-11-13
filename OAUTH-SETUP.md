# OAuth setup for the Bonsai extension

The extension supports two OAuth client paths in `background.js`. It tries them in order; whichever is correctly configured wins. Pick ONE of the paths below and configure it. Google provides no CLI or API for creating OAuth clients — both paths require some one-time clicks in Google Cloud Console.

- **Path A — Chrome-extension client + `getAuthToken`**. Nicer UX (account picker opens inside Chrome, no new tab). Requires Chrome's native sign-in to be enabled and the loaded extension's id to match the client's Item ID. Does NOT work in Brave, Arc, plain Chromium.
- **Path B — Web-application client + `launchWebAuthFlow`**. Works everywhere. Requires authorizing an `https://<extension-id>.chromiumapp.org/` redirect URI on the client.

Both paths require **pinning the extension ID**, because the id changes every time the unpacked folder is re-added and both the Item ID and the redirect URI are tied to it.

## Step 0 — Pin the extension ID (both paths)

```sh
node scripts/pin-extension-id.mjs
```

Output includes:

- A fresh `extension-key.pem` written to the repo root (gitignored via `*.pem`).
- A one-line `"key": "..."` snippet to paste into the top level of `extension/manifest.json`.
- The pinned extension ID.
- The exact redirect URI for Path B.

Keep `extension-key.pem` safe — losing it means a new id, which requires reconfiguring the OAuth client. **Never commit the `.pem`.**

Reload the unpacked extension from `chrome://extensions`. Confirm the displayed ID matches the one the script printed.

## Path A — Chrome-extension client + `getAuthToken`

1. Open [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials?project=bonsai-feed-filter) for project `bonsai-feed-filter`.
2. Either open your existing `Client ID for Chrome extension` client, or create a new one: **+ Create Credentials → OAuth client ID → Application type: Chrome Extension**.
3. Set the **Item ID** field to the pinned id from step 0 and **Save**.
4. In `extension/manifest.json`, set:

   ```json
   "oauth2": {
     "client_id": "YOUR_CHROME_EXTENSION_CLIENT_ID.apps.googleusercontent.com",
     "scopes": ["openid", "email", "profile"]
   }
   ```

5. Enable Chrome native sign-in: `chrome://settings/syncSetup` → **Allow Chrome sign-in** must be ON. Sign into Chrome with the Google account you want the extension to use.
6. Reload the extension, click **Sign in with Google** in the popup.

Known failures and fixes:

- `The user turned off browser signin` — Chrome sign-in is disabled. Re-enable in `chrome://settings/syncSetup` or switch to Path B.
- `OAuth2 request failed: Service responded with error: 'bad client id: …'` — the loaded extension's id doesn't match the client's Item ID. Re-run `pin-extension-id.mjs`, confirm the id in `chrome://extensions`, and update the Item ID field in Cloud Console.

## Path B — Web-application client + `launchWebAuthFlow`

1. Open [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials?project=bonsai-feed-filter).
2. **+ Create Credentials → OAuth client ID → Application type: Web application**. (Chrome-extension and Desktop/"installed" types will both fail here with `redirect_uri_mismatch` — you must create a new Web-application client, not reuse the existing Chrome-extension one.)
3. **Name:** e.g. `Bonsai extension (web)`.
4. **Authorized redirect URIs → Add URI:** paste the `https://<extension-id>.chromiumapp.org/` string from step 0 (trailing slash required).
5. Leave **Authorized JavaScript origins** empty.
6. **Create**, copy the **Client ID**.
7. In `extension/manifest.json`, set:

   ```json
   "oauth2": {
     "client_id": "YOUR_WEB_APP_CLIENT_ID.apps.googleusercontent.com",
     "scopes": ["openid", "email", "profile"]
   }
   ```

8. Reload the extension, click **Sign in with Google** in the popup. A Google consent screen opens in a new tab; after approving, the popup shows your name and email.

Known failures and fixes:

- `Error 400: redirect_uri_mismatch` — the redirect URI in Cloud Console doesn't exactly match what the extension sends. The popup's failure dialog now prints the exact URI; paste that verbatim, including the trailing slash.
- `Error 400: invalid_client` — the client id in `manifest.json` doesn't exist, or you're pointing at a Chrome-extension client with this code path. Create a Web-application client instead.

## After sign-in works: backend CORS

The Cloud Run backend's `ALLOWED_ORIGINS` env var must include `chrome-extension://<extension-id>`:

```sh
gcloud run services update bonsai-api \
  --project=bonsai-feed-filter --region=us-central1 \
  --update-env-vars="ALLOWED_ORIGINS=chrome-extension://<extension-id>" \
  --quiet
```

(Follow the gcloud skill's help-first rule before running variants.)

## Why not automate this?

`gcloud` exposes OAuth client creation only for IAP (deprecated, shutting down March 2026) and for its own internal credentials. Google locks general OAuth 2.0 client creation to the Cloud Console UI. Do not attempt to shell out to undocumented endpoints or scrape the Console — it will break silently.
