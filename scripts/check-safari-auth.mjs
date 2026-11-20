// @ts-check
// Safari sign-in smoke test, runnable on Linux without Safari.
//
// Loads extension/oauth-config.js + extension/background.js into a Node vm
// with a stubbed `chrome` that has no `identity` and no `webRequest`, which
// is what Safari on iOS exposes. Asserts that:
//   1. the background script evaluates without throwing,
//   2. a bonsai:oauthRedirect message from our own tab on the Safari callback
//      URL stores the user and closes the tab,
//   3. spoofed messages (wrong URL, foreign sender) are ignored,
//   4. in Chrome mode (identity present) the message path stays disabled.
// It does not replace testing in real Safari; see iOS/AGENTS.md.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = resolve(ROOT, "extension");
const CONFIG_SRC = readFileSync(resolve(EXT, "oauth-config.js"), "utf8");
const BG_SRC = readFileSync(resolve(EXT, "background.js"), "utf8").replace(
  /^import\s+["']\.\/oauth-config\.js["'];.*$/m,
  "",
);
if (/^\s*(import|export)\s/m.test(BG_SRC)) {
  throw new Error("background.js has imports/exports this harness does not handle");
}

const EXT_ID = "safari-test-extension";

/**
 * @param {{ withIdentity: boolean }} opts
 */
function makeEnv({ withIdentity }) {
  /** @type {Record<string, any>} */
  const store = {};
  /** @type {Array<(msg: any, sender: any, sendResponse: (r: any) => void) => any>} */
  const messageListeners = [];
  /** @type {number[]} */
  const removedTabs = [];
  const event = () => ({ addListener: () => {} });

  /** @param {string | string[] | null | undefined} keys */
  const pick = (keys) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  };

  /** @type {any} */
  const chrome = {
    runtime: {
      id: EXT_ID,
      getManifest: () => ({ version: "0.0.0-test" }), // Safari may drop oauth2
      getURL: (/** @type {string} */ p) => `safari-web-extension://${EXT_ID}/${p}`,
      onMessage: { addListener: (/** @type {any} */ fn) => messageListeners.push(fn) },
      onInstalled: event(),
      onStartup: event(),
      sendMessage: async () => {},
    },
    storage: {
      local: {
        get: async (/** @type {any} */ keys) => /** @type {Record<string, any>} */ (pick(keys)),
        set: async (/** @type {Record<string, any>} */ obj) => {
          Object.assign(store, obj);
        },
        remove: async (/** @type {string | string[]} */ keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        },
        clear: async () => {
          for (const k of Object.keys(store)) delete store[k];
        },
      },
      onChanged: event(),
    },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: event() },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    tabs: {
      create: async () => /** @type {{ id: number }} */ ({ id: 99 }),
      remove: async (/** @type {number} */ id) => {
        removedTabs.push(id);
      },
      query: async () => /** @type {any[]} */ ([]),
    },
    webNavigation: { onBeforeNavigate: event() },
  };
  if (withIdentity) {
    chrome.identity = { getRedirectURL: () => `https://${EXT_ID}.chromiumapp.org/` };
    chrome.webRequest = { onBeforeRequest: event() };
  }

  /** @param {string | URL} url */
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ email: "test@example.com", sub: "123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Backend calls (hydrate/drain) after sign-in: pretend they're empty.
    return new Response(JSON.stringify({ posts: [], items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const context = vm.createContext({
    chrome,
    fetch: fetchStub,
    Response,
    URL,
    URLSearchParams,
    console: { log() {}, info() {}, warn() {}, error: console.error, debug() {} },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    JSON,
    Math,
  });
  context.globalThis = context;
  vm.runInContext(CONFIG_SRC, context, { filename: "oauth-config.js" });
  vm.runInContext(BG_SRC, context, { filename: "background.js" });

  /**
   * @param {any} msg
   * @param {any} sender
   * @returns {Promise<any>}
   */
  const send = (msg, sender) =>
    new Promise((res) => {
      for (const fn of messageListeners) fn(msg, sender, res);
    });

  return { context, store, removedTabs, send };
}

/** @param {number} ms */
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
/** @param {boolean} cond @param {string} label */
function check(cond, label) {
  if (cond) {
    console.log("  ok   " + label);
  } else {
    failures += 1;
    console.log("  FAIL " + label);
  }
}

// --- Safari mode ----------------------------------------------------------
console.log("Safari mode (no chrome.identity, no chrome.webRequest)");
{
  const env = makeEnv({ withIdentity: false });
  const cfg = env.context.bonsaiOAuth;
  check(cfg.usesSafariRedirect === true, "oauth-config detects Safari");
  check(
    cfg.redirectUri.startsWith("https://") && cfg.redirectUri.endsWith("/auth/safari-callback"),
    "redirect URI points at the API callback page",
  );
  check(cfg.clientId().endsWith(".apps.googleusercontent.com"), "client id falls back without manifest.oauth2");

  const spoofUrl = await env.send(
    { type: "bonsai:oauthRedirect", url: "https://evil.example/#access_token=bad" },
    { id: EXT_ID, tab: { id: 5 } },
  );
  check(spoofUrl?.ok === false, "rejects a redirect URL that isn't the callback page");

  const spoofSender = await env.send(
    { type: "bonsai:oauthRedirect", url: `${cfg.redirectUri}#access_token=bad` },
    { id: "someone-else", tab: { id: 6 } },
  );
  check(spoofSender?.ok === false, "rejects a message from another extension");

  const res = await env.send(
    {
      type: "bonsai:oauthRedirect",
      url: `${cfg.redirectUri}#access_token=good-token&token_type=Bearer&expires_in=3599`,
    },
    { id: EXT_ID, tab: { id: 7 } },
  );
  await tick();
  check(res?.ok === true, "accepts the redirect from our own tab");
  check(env.store.bonsaiUser?.token === "good-token", "stores the signed-in user");
  check(env.store.bonsaiUser?.email === "test@example.com", "stores the user's email from userinfo");
  check(env.removedTabs.includes(7), "closes the callback tab");

  const errEnv = makeEnv({ withIdentity: false });
  errEnv.store.bonsaiUser = { email: "a@b.c", sub: "1", token: "old", stale: false };
  await errEnv.send(
    { type: "bonsai:oauthRedirect", url: `${cfg.redirectUri}#error=login_required` },
    { id: EXT_ID, tab: { id: 8 } },
  );
  await tick();
  check(errEnv.store.bonsaiUser?.stale === true, "login_required marks the user stale");
}

// --- Chrome mode ----------------------------------------------------------
console.log("Chrome mode (chrome.identity present)");
{
  const env = makeEnv({ withIdentity: true });
  const cfg = env.context.bonsaiOAuth;
  check(cfg.usesSafariRedirect === false, "oauth-config detects Chrome");
  check(cfg.redirectUri.endsWith(".chromiumapp.org/"), "redirect URI stays on chromiumapp.org");
  const res = await env.send(
    { type: "bonsai:oauthRedirect", url: `${cfg.safariRedirectUri}#access_token=x` },
    { id: EXT_ID, tab: { id: 9 } },
  );
  check(res?.ok === false, "Safari message path is disabled in Chrome");
}

if (failures > 0) {
  console.error(`Safari auth smoke test FAILED (${failures})`);
  process.exit(1);
}
console.log("Safari auth smoke test OK");
