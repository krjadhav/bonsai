// @ts-check
// Manual OAuth flow — chrome.identity.launchWebAuthFlow is unreliable on
// some Chrome builds: Google's redirect to chromiumapp.org isn't claimed
// and the tab errors out with DNS_PROBE_FINISHED_NXDOMAIN. Instead:
//
//   1. Open the Google auth URL in a child tab (chrome.tabs.create).
//   2. Watch that tab via chrome.tabs.onUpdated for a navigation to
//      <extension-id>.chromiumapp.org — which fires BEFORE DNS lookup.
//   3. Extract the access_token from the URL fragment, close the child
//      tab (before Chrome gets a chance to render the "site can't be
//      reached" error), hand the token to the service worker, close
//      this host tab.
//
// This bypasses chrome.identity entirely and only relies on chrome.tabs,
// which is rock-solid in MV3.

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

  /** @param {string} msg */
  function showError(msg) {
    $("statusLead").textContent = "Sign-in failed";
    const detail = $("statusDetail");
    detail.textContent = msg;
    detail.hidden = false;
    $("closeBtn").hidden = false;
  }

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

  /**
   * Watch a tab until its URL starts with the redirect prefix, then
   * extract and return the full redirect URL. Rejects if the tab is
   * closed before the redirect arrives.
   * @param {number} tabId
   * @param {string} redirectPrefix
   * @returns {Promise<string>}
   */
  function waitForRedirect(tabId, redirectPrefix) {
    return new Promise((resolve, reject) => {
      /** @type {(id: number, info: { url?: string }) => void} */
      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId) return;
        const url = changeInfo.url;
        if (typeof url === "string" && url.startsWith(redirectPrefix)) {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          chrome.tabs.onRemoved.removeListener(onRemoved);
          // Remove immediately so Chrome never renders the DNS error page.
          chrome.tabs.remove(tabId).catch(() => {});
          resolve(url);
        }
      };
      /** @type {(id: number) => void} */
      const onRemoved = (removedTabId) => {
        if (removedTabId !== tabId) return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        reject(new Error("Sign-in tab was closed before completing"));
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
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
      setStatus("Opening Google sign-in…");
      const authTab = await chrome.tabs.create({
        url: authUrl.toString(),
        active: true,
      });
      if (authTab.id === undefined) {
        showError("chrome.tabs.create returned no tab id");
        return;
      }

      setStatus("Waiting for Google consent…");
      const redirectUrl = await waitForRedirect(authTab.id, redirectUri);

      const hash = redirectUrl.split("#")[1] || "";
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
          `\nRedirect URI:  ${redirectUri}` +
          `\n\nAuthorized redirect URI in Cloud Console must equal the line above.`,
      );
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("closeBtn").addEventListener("click", closeSelf);
    runFlow();
  });
})();
