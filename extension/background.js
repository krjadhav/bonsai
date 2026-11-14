// @ts-check
// Bonsai background service worker (MV3, module).
// - Handles Google OAuth via chrome.identity.getAuthToken + launchWebAuthFlow.
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
// Google OAuth — dual flow.
//
// Two client types work with two different code paths:
//
//   * Chrome-extension OAuth client → chrome.identity.getAuthToken
//     - Requires the user to have Chrome native sign-in enabled
//       (chrome://settings/syncSetup → "Allow Chrome sign-in").
//     - Requires the loaded extension's id to match the client's Item ID.
//       Pin with a manifest `key` field so the unpacked id is deterministic.
//     - Does not work in Chromium forks that ship without Google API keys
//       (Brave, Arc, plain Chromium).
//
//   * Web-application OAuth client → chrome.identity.launchWebAuthFlow
//     - Works regardless of Chrome sign-in state, works in every Chromium
//       flavor.
//     - Requires `https://<extension-id>.chromiumapp.org/` listed as an
//       Authorized redirect URI on the client in Cloud Console.
//
// We try getAuthToken first because it has nicer UX when it works (the
// account picker opens inside Chrome itself rather than a new tab). On any
// failure — "The user turned off browser signin", "OAuth2 not granted",
// "bad client id" — we fall through to launchWebAuthFlow. One of the two
// client types in Cloud Console will succeed; the other will fail with a
// distinct error, which is logged for debugging.
//
// Full setup for both paths: OAUTH-SETUP.md at the repo root.
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} */
function getAuthTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "getAuthToken returned no token"));
        return;
      }
      resolve(/** @type {string} */ (token));
    });
  });
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
function launchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "launchWebAuthFlow returned no URL"));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

/**
 * @param {string} redirectUrl
 * @returns {string}
 */
function parseTokenFromRedirect(redirectUrl) {
  const hash = redirectUrl.split("#")[1] || "";
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  if (!token) {
    const err = params.get("error") || "missing access_token in redirect";
    throw new Error(err);
  }
  return token;
}

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

async function signInViaWebFlow() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2?.client_id;
  if (!clientId || clientId.startsWith("REPLACE_")) {
    throw new Error("oauth2.client_id missing or placeholder in manifest.json");
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

  const redirect = await launchWebAuthFlow(authUrl.toString());
  return parseTokenFromRedirect(redirect);
}

/** @returns {Promise<BonsaiUser>} */
async function signIn() {
  /** @type {string | undefined} */
  let token;
  try {
    token = await getAuthTokenInteractive();
  } catch (e) {
    const msg1 = /** @type {Error} */ (e)?.message || String(e);
    console.info("getAuthToken failed, falling back to launchWebAuthFlow:", msg1);
    try {
      token = await signInViaWebFlow();
    } catch (e2) {
      const msg2 = /** @type {Error} */ (e2)?.message || String(e2);
      throw new Error(`getAuthToken: ${msg1}; launchWebAuthFlow: ${msg2}`, { cause: e2 });
    }
  }
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
    try {
      await new Promise((resolve) =>
        chrome.identity.removeCachedAuthToken({ token: user.token }, () => resolve(undefined)),
      );
    } catch (e) {
      console.warn("removeCachedAuthToken failed", e);
    }
  }
  await chrome.storage.local.remove(USER_KEY);
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
        case "bonsai:signIn":
          sendResponse(await signIn());
          break;
        case "bonsai:signOut":
          sendResponse(await signOut());
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
      const msg = /** @type {Error} */ (e)?.message || String(e);
      sendResponse({ error: msg });
    }
  })();
  return true; // keep channel open for async sendResponse
});
