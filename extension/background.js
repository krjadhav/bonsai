// @ts-check
// Bonsai background service worker (MV3, module).
// - Catches the OAuth redirect to <ext-id>.chromiumapp.org and stores the user.
// - Routes messages between content script / popup / sidebar.
// - Sends captures to the backend (/posts) for persistence when signed in.

export {}; // tell TS this file is a module, so top-level decls don't clash

const STORAGE_KEY = "bonsaiCaptures";
const USER_KEY = "bonsaiUser";
const CONFIG_KEY = "bonsaiConfig";

/** @type {BonsaiConfig} */
const DEFAULT_CONFIG = {
  // Public Cloud Run URL for the bonsai-api service. Overridable per-install
  // via chrome.storage.local { bonsaiConfig: { apiBaseUrl: "..." } } sent as
  // a bonsai:setConfig message — useful for local backend development.
  apiBaseUrl: "https://bonsai-api-1000316385691.asia-south1.run.app",
};

/** @returns {Promise<BonsaiConfig>} */
async function getConfig() {
  const { [CONFIG_KEY]: cfg } = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, .../** @type {Partial<BonsaiConfig>} */ (cfg || {}) };
}

// ---------------------------------------------------------------------------
// Side panel: allow clicking the toolbar icon to open the sidebar.
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    console.warn("sidePanel.setPanelBehavior failed", e);
  }
});

// ---------------------------------------------------------------------------
// OAuth redirect catch.
//
// popup.js opens Google's /o/oauth2/v2/auth URL in a new tab. Google
// returns a 302 to <ext-id>.chromiumapp.org with the access token in the
// URL fragment. chromiumapp.org does not resolve DNS — if we don't close
// the tab before the browser tries to navigate, the user sees a
// DNS_PROBE_FINISHED_NXDOMAIN error page.
//
// webRequest.onBeforeRequest fires BEFORE the network stack starts DNS
// lookup, so we extract the token and close the tab before any error page
// renders. webNavigation.onBeforeNavigate is a fallback for navigations
// that bypass the webRequest pipeline (e.g. a manual refresh of a cached
// URL). The listener filter is pinned to the extension-id-specific redirect
// URI, so it only fires for our own flow.
//
// Previously tried (do not revive):
//   * chrome.identity.getAuthToken — requires Chrome native sign-in enabled;
//     fails with "The user turned off browser signin" otherwise. Does not
//     work on Brave / Arc / plain Chromium.
//   * chrome.identity.launchWebAuthFlow — does not reliably intercept
//     Google's server-side 302 to chromiumapp.org on current Chrome builds.
//     The tab navigates to the URL, DNS fails, interception is orphaned.
//     Playwright CDP trace confirmed only webNavigation.onErrorOccurred
//     fires (not onBeforeNavigate) for the 302 target.
// ---------------------------------------------------------------------------
const OAUTH_REDIRECT_URI = chrome.identity.getRedirectURL();

/**
 * @param {string} token
 * @returns {Promise<{ email: string, name?: string, picture?: string, sub: string }>}
 */
async function fetchUserInfo(token) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error("userinfo " + res.status);
  return res.json();
}

/**
 * Store a user object derived from an OAuth access token.
 * Invoked by the webRequest listener above, or directly via
 * bonsai:completeSignIn from popup-side flows.
 * @param {string} token
 */
async function completeSignIn(token) {
  if (!token) throw new Error("completeSignIn: missing token");
  const info = await fetchUserInfo(token);
  /** @type {BonsaiUser} */
  const user = {
    email: info.email,
    name: info.name,
    picture: info.picture,
    sub: info.sub,
    token,
  };
  await chrome.storage.local.set({ [USER_KEY]: user });
  return user;
}

/**
 * @param {string} url
 * @param {number | undefined} tabId
 */
function handleRedirectUrl(url, tabId) {
  const hash = url.split("#")[1] || "";
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  const err = params.get("error");
  if (tabId !== undefined && tabId >= 0) {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  if (err || !token) {
    console.warn("OAuth redirect without token:", err || "no access_token");
    return;
  }
  completeSignIn(token).catch((e) => console.error("completeSignIn failed", e));
}

chrome.webRequest.onBeforeRequest.addListener(
  /** @param {chrome.webRequest.OnBeforeRequestDetails} details */
  (details) => {
    if (details.type !== "main_frame") return undefined;
    if (!details.url.startsWith(OAUTH_REDIRECT_URI)) return undefined;
    handleRedirectUrl(details.url, details.tabId);
    return undefined;
  },
  { urls: [`${OAUTH_REDIRECT_URI}*`] },
);

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    if (!details.url.startsWith(OAUTH_REDIRECT_URI)) return;
    handleRedirectUrl(details.url, details.tabId);
  },
  { url: [{ urlPrefix: OAUTH_REDIRECT_URI }] },
);

async function signOut() {
  const { [USER_KEY]: userRaw } = await chrome.storage.local.get(USER_KEY);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  if (user?.token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${user.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (e) {
      console.warn("revoke failed", e);
    }
  }
  // Wipe everything — user key, captures, config overrides, onboarding flags.
  // Sign-out is a clean-slate action; leaving captures behind leaks history
  // across accounts on the same install and confuses the sidebar when the
  // next user signs in.
  await chrome.storage.local.clear();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backend post sync — single POST, no batching for simplicity.
// Pricing: insertion-only, server dedupes via unique(user_email, post_id).
// ---------------------------------------------------------------------------

/**
 * @param {BonsaiConfig} cfg
 * @param {BonsaiUser | undefined} user
 * @param {BonsaiCapture} capture
 */
async function sendPost(cfg, user, capture) {
  if (!cfg.apiBaseUrl || !user?.token) return { skipped: true };
  const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, "")}/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + user.token,
    },
    body: JSON.stringify(capture),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /posts ${res.status} ${txt}`);
  }
  return res.json().catch(() => ({ ok: true }));
}

/** @param {BonsaiCapture} capture */
async function trySendCapture(capture) {
  const [cfg, { [USER_KEY]: userRaw }] = await Promise.all([
    getConfig(),
    chrome.storage.local.get(USER_KEY),
  ]);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  if (!cfg.apiBaseUrl || !user?.token) return { skipped: true };
  try {
    return await sendPost(cfg, user, capture);
  } catch (e) {
    console.warn("sendPost failed", e);
    return { error: String(e) };
  }
}

async function syncAll() {
  const [capStore, userStore, cfg] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    chrome.storage.local.get(USER_KEY),
    getConfig(),
  ]);
  const captures = /** @type {BonsaiCapture[]} */ (capStore[STORAGE_KEY] || []);
  const user = /** @type {BonsaiUser | undefined} */ (userStore[USER_KEY]);
  if (!cfg.apiBaseUrl) return { ok: false, error: "No apiBaseUrl configured" };
  if (!user?.token) return { ok: false, error: "Not signed in" };
  let sent = 0;
  for (const cap of captures) {
    try {
      await sendPost(cfg, user, cap);
      sent++;
    } catch (e) {
      console.warn("sync item failed", cap.postId, e);
    }
  }
  return { ok: true, sent, total: captures.length };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "bonsai:completeSignIn":
          sendResponse(await completeSignIn(msg.token));
          break;
        case "bonsai:signOut":
          sendResponse(await signOut());
          break;
        case "bonsai:resetAll":
          await chrome.storage.local.clear();
          sendResponse({ ok: true });
          break;
        case "bonsai:decision":
          sendResponse(await trySendCapture(msg.payload));
          break;
        case "bonsai:syncAll":
          sendResponse(await syncAll());
          break;
        case "bonsai:getConfig":
          sendResponse(await getConfig());
          break;
        case "bonsai:setConfig":
          await chrome.storage.local.set({ [CONFIG_KEY]: msg.payload || {} });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ error: "unknown message type" });
      }
    } catch (e) {
      const errMsg = /** @type {Error} */ (e)?.message || String(e);
      sendResponse({ error: errMsg });
    }
  })();
  return true; // keep channel open for async sendResponse
});
