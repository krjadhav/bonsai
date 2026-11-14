// @ts-check
// Detached OAuth window. Runs launchWebAuthFlow from a chrome.windows.create
// popup that does NOT close on blur — unlike the extension action popup,
// which closes the instant the auth tab steals focus and orphans the
// launchWebAuthFlow promise, leaving the chromiumapp.org redirect
// uncaught (DNS_PROBE_FINISHED_NXDOMAIN).

(() => {
  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not in oauth DOM`);
    return el;
  };

  /** @param {string} msg */
  function setStatus(msg) {
    $("statusLead").textContent = msg;
  }

  // Close whatever surface hosts this page. Works both when opened via
  // chrome.tabs.create (regular tab — window.close is a no-op, need
  // chrome.tabs.remove) and chrome.windows.create (detached popup —
  // chrome.tabs.remove still works).
  async function closeSelf() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id !== undefined) {
        await chrome.tabs.remove(tab.id);
        return;
      }
    } catch (e) {
      console.warn("chrome.tabs.remove failed", e);
    }
    window.close();
  }

  /** @param {string} msg */
  function showError(msg) {
    $("statusLead").textContent = "Sign-in failed";
    const detail = $("statusDetail");
    detail.textContent = msg;
    detail.hidden = false;
    $("closeBtn").hidden = false;
  }

  async function runFlow() {
    const manifest = chrome.runtime.getManifest();
    $("verLabel").textContent = "v" + manifest.version;

    const clientId = manifest.oauth2?.client_id;
    if (!clientId || clientId.startsWith("REPLACE_")) {
      showError("oauth2.client_id missing or placeholder in manifest.json");
      return;
    }
    const scopes = (manifest.oauth2?.scopes || ["openid", "email", "profile"]).join(" ");
    const redirectUri = chrome.identity.getRedirectURL();

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "token");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("prompt", "consent");

    try {
      setStatus("Waiting for Google consent…");
      const redirectResponse = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
      });
      if (!redirectResponse) {
        showError("launchWebAuthFlow returned no URL");
        return;
      }
      const hash = redirectResponse.split("#")[1] || "";
      const params = new URLSearchParams(hash);
      const token = params.get("access_token");
      if (!token) {
        const err = params.get("error") || "missing access_token in redirect";
        showError(err);
        return;
      }
      setStatus("Signing you in…");
      const resp = await chrome.runtime.sendMessage({
        type: "bonsai:completeSignIn",
        token,
      });
      if (!resp || resp.error) {
        showError(resp?.error || "completeSignIn returned no user");
        return;
      }
      setStatus("Signed in. Closing…");
      closeSelf();
    } catch (e) {
      const msg = /** @type {Error} */ (e)?.message || String(e);
      showError(
        msg +
          `\n\nExtension id:  ${chrome.runtime.id}` +
          `\nRedirect URI:  ${chrome.identity.getRedirectURL()}` +
          `\n\nAuthorized redirect URI in Cloud Console must equal the line above.`,
      );
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("closeBtn").addEventListener("click", () => window.close());
    runFlow();
  });
})();
