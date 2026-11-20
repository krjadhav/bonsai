// @ts-check
// Content script for the Safari sign-in landing page
// (https://<api>/auth/safari-callback). Google puts the access token, or an
// error, in the URL fragment. Pass the full URL to the background, which
// stores the user and closes this tab, then strip the fragment so the token
// doesn't linger in the address bar or history. Chrome never loads this page.
(() => {
  const hash = location.hash;
  const hasResult =
    hash.includes("access_token=") ||
    hash.includes("error=") ||
    location.search.includes("error=");
  if (!hasResult) return;
  const url = location.href;
  history.replaceState(null, "", location.pathname);
  chrome.runtime.sendMessage({ type: "bonsai:oauthRedirect", url }).catch((e) => {
    console.warn("Bonsai: could not reach background for sign-in", e);
  });
})();
