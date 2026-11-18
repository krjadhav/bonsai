// @ts-check
// Bonsai background service worker (MV3, module).
// - Catches the OAuth redirect to <ext-id>.chromiumapp.org and stores the user.
// - Routes messages between content script / popup.
// - Sends captures to the backend (/posts) for persistence when signed in.

export {}; // tell TS this file is a module, so top-level decls don't clash

const STORAGE_KEY = "bonsaiCaptures";
const USER_KEY = "bonsaiUser";
const CONFIG_KEY = "bonsaiConfig";
// Captures that have not yet been accepted by the backend. Every decision
// enqueues here first, then drains to /posts. Failed posts stay queued and
// retry on the next successful auth / wake event. See
// .local/postmortem-2026-11-17-token-expiry-data-loss.md for why.
const PENDING_KEY = "bonsaiPending";
const MAX_PENDING = 1000;
// Pending DELETEs. When a user clicks Remove we drop the capture locally
// right away and enqueue the postId here as a tombstone. drainPendingDeletes
// fires DELETE /posts/<id>; on offline/5xx we keep retrying, on 401 we stop
// and mark the token stale. The tombstone also prevents hydrateFromBackend
// from resurrecting the record before the backend has caught up.
const PENDING_DELETES_KEY = "bonsaiPendingDeletes";
const MAX_PENDING_DELETES = 1000;
// Google access tokens expire at 3600s. Schedule the silent prompt=none
// reauth at 55 minutes so a fresh token is in hand before any POST / GET
// has a chance to 401.
const TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const ALARM_SILENT_REAUTH = "bonsai:silentReauth";

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
// Install hooks:
//   * Fresh install only: open the onboarding tab. Users rarely pin the
//     extension, so we cannot rely on the popup for first-run setup.
// ---------------------------------------------------------------------------
// Service workers wake on install, update, browser start, and after idle
// eviction. Pull backend state on every wake if we're signed in — one GET
// against a user-scoped query is well under the Firestore free tier, and it
// fixes the reinstall-zeros-the-progress-bar class of bug.
chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await restoreAuthBadge();
    await scheduleSilentReauth();
    // Drain deletes before hydrating — otherwise the GET /posts response
    // would re-populate local storage with rows the user had already asked
    // to remove, and they'd flicker back in until the next drain.
    await drainPendingDeletes().catch((e) => console.warn("startup delete drain failed", e));
    hydrateFromBackend().catch((e) => console.warn("startup hydrate failed", e));
    drainPending().catch((e) => console.warn("startup drain failed", e));
  })();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    } catch (e) {
      console.warn("open onboarding tab failed", e);
    }
  }
  // Update and reload paths: keep the badge in sync with the stored user and
  // (re)arm the silent-reauth alarm. Reloads of an unpacked extension land
  // here rather than in onStartup.
  await restoreAuthBadge();
  await scheduleSilentReauth();
  drainPendingDeletes().catch((e) => console.warn("install delete drain failed", e));
  drainPending().catch((e) => console.warn("install drain failed", e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SILENT_REAUTH) {
    silentReauth().catch((e) => console.warn("silent reauth failed", e));
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
 * Build the Google OAuth consent / silent-reauth URL. onboarding.js has its
 * own copy for first-time sign-in (user gesture required there); this one
 * drives the service worker's silent reauth before token expiry.
 * @param {"consent" | "none"} promptMode
 * @returns {string}
 */
function buildAuthUrl(promptMode) {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2?.client_id;
  if (!clientId) throw new Error("oauth2.client_id missing from manifest");
  const scopes = (manifest.oauth2?.scopes || ["openid", "email", "profile"]).join(" ");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", promptMode);
  return authUrl.toString();
}

// One-flight gate for silent reauth: the alarm might fire while a prior
// silent tab is still open (slow network, Google hiccup). Second firings are
// dropped instead of stacking tabs.
let silentReauthInFlight = false;

// Open the Google auth URL with prompt=none in a background tab. If Google's
// SSO cookie is alive the 302 to chromiumapp.org carries a fresh access_token
// and webRequest.onBeforeRequest closes the tab before any page paints. If
// Google returns error=login_required (user cleared cookies, signed out of
// Google, etc.) handleRedirectUrl marks the stored user stale so the popup
// surfaces a re-sign-in CTA. Called from onStartup, onInstalled, and the
// bonsai:silentReauth alarm.
async function silentReauth() {
  if (silentReauthInFlight) return;
  const { [USER_KEY]: userRaw } = await chrome.storage.local.get(USER_KEY);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  if (!user?.token) return;
  silentReauthInFlight = true;
  try {
    const url = buildAuthUrl("none");
    await chrome.tabs.create({ url, active: false });
  } catch (e) {
    console.warn("silentReauth tab open failed", e);
  } finally {
    // Clear the flight flag shortly — the actual completion lands in
    // handleRedirectUrl asynchronously. Five seconds is enough for Google's
    // 302 to arrive on any reasonable connection.
    setTimeout(() => {
      silentReauthInFlight = false;
    }, 5000);
  }
}

// Fire a silent-reauth alarm at TOKEN_LIFETIME_MS past the last token issue.
// If the token is already past that window, fire immediately. No-ops when
// signed out or already marked stale (the popup drives re-sign-in instead).
async function scheduleSilentReauth() {
  const { [USER_KEY]: userRaw } = await chrome.storage.local.get(USER_KEY);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  if (!user?.token || user.stale) {
    await chrome.alarms.clear(ALARM_SILENT_REAUTH);
    return;
  }
  const issuedAt = user.tokenIssuedAt || 0;
  const remainingMs = TOKEN_LIFETIME_MS - (Date.now() - issuedAt);
  if (remainingMs <= 0) {
    silentReauth().catch((e) => console.warn("inline silent reauth failed", e));
    return;
  }
  // chrome.alarms minimum delay is 30s on packed extensions; use at least 1
  // minute to stay portable across unpacked and packed builds.
  const delayInMinutes = Math.max(1, remainingMs / 60000);
  await chrome.alarms.create(ALARM_SILENT_REAUTH, { delayInMinutes });
}

// Paint the extension action badge. `!` + red = stale / needs re-sign-in.
// Keeps the popup icon self-announcing when sync has been paused.
/** @param {boolean} stale */
async function setAuthBadge(stale) {
  try {
    if (stale) {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#e8745a" });
      await chrome.action.setTitle({ title: "Bonsai — sign in again" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "Bonsai" });
    }
  } catch (e) {
    console.warn("badge set failed", e);
  }
}

async function restoreAuthBadge() {
  const { [USER_KEY]: userRaw } = await chrome.storage.local.get(USER_KEY);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  await setAuthBadge(Boolean(user?.stale));
}

/**
 * Flip the stored user to stale and show the badge. Idempotent — repeat
 * 401s do not spam storage writes.
 */
async function markAuthStale() {
  const { [USER_KEY]: userRaw } = await chrome.storage.local.get(USER_KEY);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  if (!user || user.stale) return;
  await chrome.storage.local.set({ [USER_KEY]: { ...user, stale: true } });
  await chrome.alarms.clear(ALARM_SILENT_REAUTH);
  await setAuthBadge(true);
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
    tokenIssuedAt: Date.now(),
    stale: false,
  };
  await chrome.storage.local.set({ [USER_KEY]: user });
  await setAuthBadge(false);
  await scheduleSilentReauth();
  // Drain deletes first so the subsequent hydrate doesn't resurrect ids
  // the user already asked to tombstone while signed out.
  (async () => {
    await drainPendingDeletes().catch((e) => console.warn("post sign-in delete drain failed", e));
    hydrateFromBackend().catch((e) => console.warn("post sign-in hydrate failed", e));
    drainPending().catch((e) => console.warn("post sign-in drain failed", e));
  })();
  return user;
}

/**
 * @param {string} url
 * @param {number | undefined} tabId
 */
function handleRedirectUrl(url, tabId) {
  const hash = url.split("#")[1] || "";
  const params = new URLSearchParams(hash);
  // prompt=none errors can also land in the query string; check both.
  const searchParams = new URL(url).searchParams;
  const token = params.get("access_token");
  const err = params.get("error") || searchParams.get("error");
  if (tabId !== undefined && tabId >= 0) {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  if (err) {
    console.warn("OAuth redirect error:", err);
    // prompt=none silent reauth returning these errors means Google's SSO
    // cookie is gone — fall back to interactive sign-in via popup CTA.
    if (
      err === "login_required" ||
      err === "interaction_required" ||
      err === "consent_required"
    ) {
      markAuthStale().catch((e) => console.warn("markAuthStale failed", e));
    }
    return;
  }
  if (!token) {
    console.warn("OAuth redirect without token or error");
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
  // Best-effort flush of anything that failed to POST earlier in the session
  // so the user's unsynced work reaches the backend before we throw away the
  // token. Capped at 5 s so sign-out stays snappy even if Cloud Run is cold.
  try {
    await Promise.race([
      Promise.all([drainPendingDeletes(), drainPending()]),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (e) {
    console.warn("pre-signOut drain failed", e);
  }
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
  // Soft sign-out: remove ONLY the user identity. Captures, pending queue,
  // config overrides, and onboarding state all survive. When the same Google
  // sub signs in again hydrate merges Firestore back into local; pending
  // drains to the backend; the teaching-progress counter keeps its history.
  //
  // A previous implementation ran chrome.storage.local.clear() here and
  // silently lost any capture whose POST had 401'd on the expired token —
  // see .local/postmortem-2026-11-17-token-expiry-data-loss.md. Do NOT
  // reintroduce the hard clear without a replacement durable-store first.
  await chrome.storage.local.remove([USER_KEY]);
  await chrome.alarms.clear(ALARM_SILENT_REAUTH);
  await setAuthBadge(false);
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
    // Attach status so drainPending can treat 401 specially (stop retrying,
    // mark the token stale) without parsing a string.
    const err = /** @type {Error & { status?: number }} */ (
      new Error(`POST /posts ${res.status} ${txt}`)
    );
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({ ok: true }));
}

// Serialize all writes to bonsaiPending so two near-simultaneous decisions
// (e.g., rapid yes-yes clicks) never read the same snapshot and overwrite
// each other. chrome.storage set is atomic per-write but not transactional
// across read-modify-write pairs.
let pendingWriteChain = Promise.resolve();

/** @param {BonsaiCapture} capture */
async function enqueuePending(capture) {
  pendingWriteChain = pendingWriteChain.then(async () => {
    const { [PENDING_KEY]: raw } = await chrome.storage.local.get(PENDING_KEY);
    const pending = /** @type {BonsaiCapture[]} */ (raw || []);
    const idx = pending.findIndex((c) => c.postId && c.postId === capture.postId);
    if (idx >= 0) pending[idx] = capture;
    else pending.push(capture);
    // Oldest-first drop if the queue runs away (user offline for weeks, say).
    // Captures are idempotent on backend via doc id so re-adds cost nothing,
    // but local storage has a ~10 MB ceiling.
    while (pending.length > MAX_PENDING) pending.shift();
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
  });
  return pendingWriteChain;
}

// One-flight gate for drainPending. Alarms and decision-sends can both
// trigger it; a second call piggy-backs on the first's result instead of
// double-sending the same captures.
let drainInFlight = /** @type {Promise<{ drained: number, remaining: number } | { skipped: true }> | null} */ (
  null
);

async function drainPending() {
  if (drainInFlight) return drainInFlight;
  drainInFlight = (async () => {
    const [cfg, { [USER_KEY]: userRaw }, { [PENDING_KEY]: raw }] = await Promise.all([
      getConfig(),
      chrome.storage.local.get(USER_KEY),
      chrome.storage.local.get(PENDING_KEY),
    ]);
    const user = /** @type {BonsaiUser | undefined} */ (userRaw);
    const pending = /** @type {BonsaiCapture[]} */ (raw || []);
    if (!cfg.apiBaseUrl || !user?.token || user.stale || pending.length === 0) {
      return { drained: 0, remaining: pending.length };
    }
    /** @type {BonsaiCapture[]} */
    const remaining = [];
    let drained = 0;
    for (let i = 0; i < pending.length; i++) {
      const cap = pending[i];
      try {
        await sendPost(cfg, user, cap);
        drained++;
      } catch (e) {
        const err = /** @type {Error & { status?: number }} */ (e);
        remaining.push(cap);
        if (err.status === 401) {
          // Token dead — everything else in the queue will 401 too. Stop,
          // flag stale, keep the rest queued for the next successful auth.
          await markAuthStale();
          for (let j = i + 1; j < pending.length; j++) remaining.push(pending[j]);
          break;
        }
        // Non-auth failure (network blip, 5xx). Keep the item queued and
        // keep trying the rest — maybe they'll succeed and we'll drain later.
      }
    }
    await chrome.storage.local.set({ [PENDING_KEY]: remaining });
    return { drained, remaining: remaining.length };
  })().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

// Entry point from content.js when a user rates a post. The decision is
// already in bonsaiCaptures (content.js owns that store); here we make sure
// it also lands in the backend, going through bonsaiPending as a durable
// buffer against any transient failure.
/** @param {BonsaiCapture} capture */
async function trySendCapture(capture) {
  await enqueuePending(capture);
  return drainPending();
}

// ---------------------------------------------------------------------------
// Backend delete sync — mirrors the capture pipeline.
// ---------------------------------------------------------------------------

/**
 * @param {BonsaiConfig} cfg
 * @param {BonsaiUser | undefined} user
 * @param {string} postId
 */
async function sendDelete(cfg, user, postId) {
  if (!cfg.apiBaseUrl || !user?.token) return { skipped: true };
  const url = `${cfg.apiBaseUrl.replace(/\/$/, "")}/posts/${encodeURIComponent(postId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + user.token },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = /** @type {Error & { status?: number }} */ (
      new Error(`DELETE /posts/${postId} ${res.status} ${txt}`)
    );
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({ ok: true }));
}

let pendingDeleteWriteChain = Promise.resolve();

/** @param {string} postId */
async function enqueuePendingDelete(postId) {
  pendingDeleteWriteChain = pendingDeleteWriteChain.then(async () => {
    const { [PENDING_DELETES_KEY]: raw } = await chrome.storage.local.get(PENDING_DELETES_KEY);
    const pending = /** @type {string[]} */ (raw || []);
    if (!pending.includes(postId)) pending.push(postId);
    while (pending.length > MAX_PENDING_DELETES) pending.shift();
    await chrome.storage.local.set({ [PENDING_DELETES_KEY]: pending });
  });
  return pendingDeleteWriteChain;
}

let deleteDrainInFlight = /** @type {Promise<{ drained: number, remaining: number } | { skipped: true }> | null} */ (
  null
);

async function drainPendingDeletes() {
  if (deleteDrainInFlight) return deleteDrainInFlight;
  deleteDrainInFlight = (async () => {
    const [cfg, { [USER_KEY]: userRaw }, { [PENDING_DELETES_KEY]: raw }] = await Promise.all([
      getConfig(),
      chrome.storage.local.get(USER_KEY),
      chrome.storage.local.get(PENDING_DELETES_KEY),
    ]);
    const user = /** @type {BonsaiUser | undefined} */ (userRaw);
    const pending = /** @type {string[]} */ (raw || []);
    if (!cfg.apiBaseUrl || !user?.token || user.stale || pending.length === 0) {
      return { drained: 0, remaining: pending.length };
    }
    /** @type {string[]} */
    const remaining = [];
    let drained = 0;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      try {
        await sendDelete(cfg, user, id);
        drained++;
      } catch (e) {
        const err = /** @type {Error & { status?: number }} */ (e);
        remaining.push(id);
        if (err.status === 401) {
          await markAuthStale();
          for (let j = i + 1; j < pending.length; j++) remaining.push(pending[j]);
          break;
        }
      }
    }
    await chrome.storage.local.set({ [PENDING_DELETES_KEY]: remaining });
    return { drained, remaining: remaining.length };
  })().finally(() => {
    deleteDrainInFlight = null;
  });
  return deleteDrainInFlight;
}

/** @param {string | null | undefined} postId */
async function trySendRemove(postId) {
  if (!postId) return { skipped: true };
  // Drop any still-queued POST for this id so we never ship the capture
  // right after the user asked to delete it.
  const { [PENDING_KEY]: raw } = await chrome.storage.local.get(PENDING_KEY);
  const pending = /** @type {BonsaiCapture[]} */ (raw || []);
  const filtered = pending.filter((c) => c.postId !== postId);
  if (filtered.length !== pending.length) {
    await chrome.storage.local.set({ [PENDING_KEY]: filtered });
  }
  await enqueuePendingDelete(postId);
  return drainPendingDeletes();
}

// Pull every post this user previously submitted and merge into local storage.
// Runs after sign-in and on service-worker startup so a fresh install (or new
// device) rehydrates the teaching-progress bar instead of restarting the
// count from zero. Local wins on conflict: if the user rated the same post
// twice offline, their most recent local decision stays.
async function hydrateFromBackend() {
  const [cfg, { [USER_KEY]: userRaw }, { [STORAGE_KEY]: capRaw }, { [PENDING_DELETES_KEY]: tombsRaw }] = await Promise.all([
    getConfig(),
    chrome.storage.local.get(USER_KEY),
    chrome.storage.local.get(STORAGE_KEY),
    chrome.storage.local.get(PENDING_DELETES_KEY),
  ]);
  const user = /** @type {BonsaiUser | undefined} */ (userRaw);
  if (!cfg.apiBaseUrl || !user?.token) return { skipped: true };
  let items;
  try {
    const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, "")}/posts`, {
      headers: { Authorization: "Bearer " + user.token },
    });
    if (res.status === 401) {
      await markAuthStale();
      return { error: "GET /posts 401" };
    }
    if (!res.ok) throw new Error(`GET /posts ${res.status}`);
    const body = await res.json();
    items = /** @type {BonsaiCapture[]} */ (body.items || []);
  } catch (e) {
    console.warn("hydrateFromBackend failed", e);
    return { error: String(e) };
  }
  // Tombstoned ids: user already asked to remove these, but the DELETE
  // hasn't drained yet. Don't let the GET resurrect them.
  const tombs = new Set(/** @type {string[]} */ (tombsRaw || []));
  const local = /** @type {BonsaiCapture[]} */ (capRaw || []);
  const byId = new Map();
  for (const it of items) if (it.postId && !tombs.has(it.postId)) byId.set(it.postId, it);
  for (const it of local) if (it.postId && !tombs.has(it.postId)) byId.set(it.postId, it); // local wins
  const merged = [...byId.values()].sort((a, b) => {
    const at = a.decidedAt || a.capturedAt || "";
    const bt = b.decidedAt || b.capturedAt || "";
    return bt.localeCompare(at);
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return { ok: true, pulled: items.length, total: merged.length };
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
        case "bonsai:removeDecision":
          sendResponse(await trySendRemove(msg.postId));
          break;
        case "bonsai:syncAll":
          sendResponse(await syncAll());
          break;
        case "bonsai:hydrate":
          sendResponse(await hydrateFromBackend());
          break;
        case "bonsai:drainPending":
          sendResponse(await drainPending());
          break;
        case "bonsai:silentReauth":
          await silentReauth();
          sendResponse({ ok: true });
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
