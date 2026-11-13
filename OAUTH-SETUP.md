# OAuth client setup for the Bonsai extension

The extension signs users in via `chrome.identity.launchWebAuthFlow` against Google's OAuth 2.0 authorization endpoint. That flow requires an OAuth client of type **Web application** in Google Cloud Console — Chrome-Extension and Desktop ("installed") client types will both reject the `chromiumapp.org` redirect with `redirect_uri_mismatch`.

Google does not expose a CLI or API for creating these clients. The steps below must be done once per OAuth client in the browser.

## Steps

### 1. Load the extension unpacked and copy its ID

1. Open `chrome://extensions` and enable **Developer mode** (top right).
2. Click **Load unpacked** and select the repo's `extension/` directory.
3. Copy the extension ID shown under the Bonsai card. It looks like `abcdefghijklmnopabcdefghijklmnop` (32 lowercase letters).

The redirect URI the extension will send to Google is:

```
https://<extension-id>.chromiumapp.org/
```

If you forget the ID later, open the service-worker console from `chrome://extensions` → Bonsai → **Inspect views → service worker** and run `chrome.runtime.id` or `chrome.identity.getRedirectURL()`.

### 2. Create a Web-application OAuth client

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials?project=bonsai-feed-filter) for project `bonsai-feed-filter`.
2. Click **+ Create Credentials** → **OAuth client ID**.
3. **Application type:** `Web application`.
4. **Name:** e.g. `Bonsai extension (web)`.
5. Under **Authorized redirect URIs**, click **Add URI** and paste `https://<extension-id>.chromiumapp.org/` (use the ID from step 1).
6. Leave **Authorized JavaScript origins** empty — the extension never calls Google APIs from a web origin.
7. Click **Create**. Copy the resulting **Client ID** (ends in `.apps.googleusercontent.com`).

> Do not reuse the existing `installed` (Desktop) client — that type cannot accept this redirect URI. Create a new one.

### 3. Point the extension at the new client

Edit `extension/manifest.json` and set:

```json
"oauth2": {
  "client_id": "YOUR_NEW_WEB_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["openid", "email", "profile"]
}
```

Reload the extension from `chrome://extensions` (the circular-arrow icon on the card).

### 4. Verify

Click the Bonsai toolbar icon → **Sign in with Google**. A Google consent screen should open. After approving, the popup should show your name and email. If you still see `redirect_uri_mismatch`:

- The redirect URI you pasted in step 2 must end in a trailing `/`.
- The extension ID in step 1 must match the ID currently shown in `chrome://extensions`. Reinstalling the unpacked folder may change the ID — use the pinning step below to prevent that.
- The failure dialog in the popup now prints the exact redirect URI the extension is sending; paste that verbatim into the Cloud Console.

## Pin the extension ID across unpacked reloads (optional but recommended)

Without a `key` field, Chrome derives the extension ID from the unpacked path. Re-adding the folder (or sharing across machines) changes the ID and breaks the saved redirect URI. Pin it:

1. In `chrome://extensions`, click **Pack extension**, select `extension/`, and click **Pack**. Chrome writes a `.pem` private key next to the folder.
2. Convert the key to a base64 public key suitable for the manifest `key` field:

   ```sh
   openssl rsa -in extension.pem -pubout -outform DER \
     | openssl base64 -A
   ```

3. Paste the one-line output into `extension/manifest.json`:

   ```json
   "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCg...",
   ```

4. Reload the extension. The ID is now deterministic. Confirm it matches the redirect URI configured in Cloud Console.

**Never commit the `.pem` private key.** Add it to `.gitignore` if it lands inside the repo. The public `key` field in `manifest.json` is safe to commit.

## Backend CORS

`ALLOWED_ORIGINS` on the Cloud Run service must include `chrome-extension://<extension-id>`. Update with:

```sh
gcloud run services update bonsai-api \
  --project=bonsai-feed-filter --region=us-central1 \
  --update-env-vars="ALLOWED_ORIGINS=chrome-extension://<extension-id>" \
  --quiet
```

(Follow the gcloud skill's help-first rule before running variants of this command.)
