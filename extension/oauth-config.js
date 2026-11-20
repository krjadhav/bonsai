// @ts-check
// OAuth settings shared by background.js (imported as a module side effect)
// and onboarding.html (loaded as a classic script before onboarding.js).
//
// Chrome redirects Google sign-in to https://<ext-id>.chromiumapp.org/ via
// chrome.identity.getRedirectURL(). Safari has no chrome.identity, so the
// Safari build redirects to a static page on the Bonsai API instead;
// oauth-callback.js runs there and hands the URL fragment to the background.
// The Safari URI must be registered on the same Google OAuth client.
(() => {
  const SAFARI_REDIRECT_URI =
    "https://bonsai-api-1000316385691.asia-south1.run.app/auth/safari-callback";
  // Mirrors manifest.oauth2. Safari ignores the oauth2 key, so getManifest()
  // may not return it there.
  const CLIENT_ID = "1000316385691-cciusj7cbm5ru7bb2kaaph5d4ih96ouk.apps.googleusercontent.com";
  const SCOPES = ["openid", "email", "profile"];

  const hasIdentity = typeof chrome.identity?.getRedirectURL === "function";

  /** @type {BonsaiOAuthConfig} */
  const config = {
    redirectUri: hasIdentity ? chrome.identity.getRedirectURL() : SAFARI_REDIRECT_URI,
    safariRedirectUri: SAFARI_REDIRECT_URI,
    usesSafariRedirect: !hasIdentity,
    clientId() {
      const fromManifest = chrome.runtime.getManifest().oauth2?.client_id;
      return fromManifest && !fromManifest.startsWith("REPLACE_") ? fromManifest : CLIENT_ID;
    },
    scopes() {
      return chrome.runtime.getManifest().oauth2?.scopes || SCOPES;
    },
  };
  globalThis.bonsaiOAuth = config;
})();
