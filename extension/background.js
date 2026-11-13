// Bonsai background service worker (MV3, module).
// - Handles Google OAuth via chrome.identity.getAuthToken
// - Routes messages between content script / popup / sidebar
// - Sends captures to the backend (/posts) for persistence when signed in

const STORAGE_KEY = "bonsaiCaptures";
const USER_KEY = "bonsaiUser";
const CONFIG_KEY = "bonsaiConfig";

const DEFAULT_CONFIG = {
  // Leave empty until the user points at a deployed backend. When empty,
  // captures stay in chrome.storage.local and are *not* POSTed anywhere.
  apiBaseUrl: "",
};

async function getConfig() {
  const { [CONFIG_KEY]: cfg } = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(cfg || {}) };
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
// Google OAuth — launchWebAuthFlow path.
//
// Why not chrome.identity.getAuthToken? That API is bound to Chrome's native
// Google account integration; it fails with "The user turned off browser
// signin" when Chrome sign-in is disabled, and also breaks on Chromium-based
// browsers that ship without Google API keys (Brave, Arc, plain Chromium).
// launchWebAuthFlow is the standards-based OAuth 2.0 implicit flow routed
// through chrome.identity.getRedirectURL() — it works in every Chromium flavor
// regardless of the user's sync settings.
//
// Requirement: the OAuth client in manifest.json MUST be a Google Cloud
// Console client of type "Web application" (not "Chrome Extension") with
// `https://<extension-id>.chromiumapp.org/` added as an Authorized redirect
// URI. Pin the extension ID by adding a `key` to manifest.json during
// development so the redirect URI doesn't change on every unpacked reload.
// ---------------------------------------------------------------------------
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

async function fetchUserInfo(token) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error("userinfo " + res.status);
  return res.json();
}

async function signIn() {
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
  const token = parseTokenFromRedirect(redirect);
  const info = await fetchUserInfo(token);
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
  const { [USER_KEY]: user } = await chrome.storage.local.get(USER_KEY);
  if (user?.token) {
    try {
      // Standard OAuth 2.0 revoke endpoint. launchWebAuthFlow doesn't use
      // chrome.identity's token cache, so no removeCachedAuthToken needed.
      await fetch(`https://oauth2.googleapis.com/revoke?token=${user.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (e) {
      console.warn("revoke failed", e);
    }
  }
  await chrome.storage.local.remove(USER_KEY);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backend post sync — single POST, no batching for simplicity.
// Pricing: insertion-only, server dedupes via unique(user_email, post_id).
// ---------------------------------------------------------------------------
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

async function trySendCapture(capture) {
  const [cfg, { [USER_KEY]: user }] = await Promise.all([
    getConfig(),
    chrome.storage.local.get(USER_KEY),
  ]);
  if (!cfg.apiBaseUrl || !user?.token) return { skipped: true };
  try {
    return await sendPost(cfg, user, capture);
  } catch (e) {
    console.warn("sendPost failed", e);
    return { error: String(e) };
  }
}

async function syncAll() {
  const [{ [STORAGE_KEY]: captures = [] }, { [USER_KEY]: user }, cfg] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    chrome.storage.local.get(USER_KEY),
    getConfig(),
  ]);
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
      sendResponse({ error: String(e?.message || e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});
