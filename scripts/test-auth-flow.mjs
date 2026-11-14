#!/usr/bin/env node
// @ts-nocheck
// (tsc can't type-check closures passed via sw.evaluate — they're serialized)
// Attach to the running Chromium at http://localhost:9222 via Playwright
// (which, unlike puppeteer's default target set, surfaces MV3 service
// workers) and watch the Bonsai OAuth flow. Does not touch the user's
// profile — opens the Google auth URL in a new tab, instruments the SW
// with webNavigation/tabs/storage listeners, and prints every event so we
// can diagnose where the chromiumapp.org redirect is being lost.

import { chromium } from "playwright";

const EXT_ID = "ikphaopppanoafiolcddccclmkdcmpin";
const PROJECT_CLIENT_ID =
  "1000316385691-cciusj7cbm5ru7bb2kaaph5d4ih96ouk.apps.googleusercontent.com";
const REDIRECT_URI = `https://${EXT_ID}.chromiumapp.org/`;

/** @param {string} tag @param {...any} args */
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${tag}`, ...args);
}

async function main() {
  log("boot", "connecting via CDP to http://localhost:9222 …");
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const [ctx] = browser.contexts();
  if (!ctx) {
    log("error", "no browser context found");
    process.exit(1);
  }
  log("boot", "connected. contexts:", browser.contexts().length);

  // --- find the Bonsai service worker -------------------------------------
  const workers = ctx.serviceWorkers();
  log("sw", `found ${workers.length} service workers in context`);
  const sw = workers.find((w) => w.url().includes(EXT_ID));
  if (!sw) {
    log("error", "Bonsai service worker not in context.serviceWorkers()");
    for (const w of workers) log("  sw:", w.url().slice(0, 100));
    process.exit(1);
  }
  log("sw", "attached:", sw.url());

  // Capture SW console output via an in-SW buffer we poll. playwright's
  // ServiceWorker doesn't expose a console event, and newCDPSession doesn't
  // accept workers. Monkey-patch console.{log,warn,error,info} inside the
  // worker to push into a global array, then drain it on an interval.
  await sw.evaluate(() => {
    const g = /** @type {any} */ (globalThis);
    if (g.__bonsaiConsoleBuf) return;
    g.__bonsaiConsoleBuf = [];
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
    };
    for (const level of /** @type {const} */ (["log", "warn", "error", "info"])) {
      console[level] = (...args) => {
        try {
          g.__bonsaiConsoleBuf.push({
            level,
            at: Date.now(),
            text: args
              .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
              .join(" "),
          });
          if (g.__bonsaiConsoleBuf.length > 500) g.__bonsaiConsoleBuf.shift();
        } catch {
          /* ignore */
        }
        orig[level](...args);
      };
    }
  });
  const consolePoll = setInterval(async () => {
    try {
      const batch = await sw.evaluate(() => {
        const g = /** @type {any} */ (globalThis);
        const b = g.__bonsaiConsoleBuf || [];
        g.__bonsaiConsoleBuf = [];
        return b;
      });
      for (const e of batch) log(`sw.${e.level}`, e.text);
    } catch {
      /* ignore transient disconnect */
    }
  }, 300);

  // --- diagnostics --------------------------------------------------------
  const diag = await sw.evaluate(() => {
    const c = /** @type {any} */ (globalThis).chrome;
    return {
      extensionId: c.runtime.id,
      redirectUri: c.identity.getRedirectURL(),
      clientId: c.runtime.getManifest().oauth2?.client_id,
      version: c.runtime.getManifest().version,
      perms: c.runtime.getManifest().permissions,
    };
  });
  log("sw.diag", diag);

  const storage = await sw.evaluate(() =>
    /** @type {any} */ (globalThis).chrome.storage.local.get(null),
  );
  log("sw.storage", "initial:", JSON.stringify(storage).slice(0, 200));

  // --- wire test listeners inside the SW ---------------------------------
  log("sw", "wiring instrumentation listeners …");
  await sw.evaluate(() => {
    const c = /** @type {any} */ (globalThis).chrome;
    const g = /** @type {any} */ (globalThis);
    if (g.__bonsaiTest) return;
    g.__bonsaiTest = true;
    c.webNavigation.onBeforeNavigate.addListener((d) =>
      console.log(
        "TEST webNavigation.onBeforeNavigate",
        JSON.stringify({ tabId: d.tabId, frameId: d.frameId, url: d.url.slice(0, 300) }),
      ),
    );
    c.webNavigation.onCommitted.addListener((d) =>
      console.log(
        "TEST webNavigation.onCommitted",
        JSON.stringify({
          tabId: d.tabId,
          frameId: d.frameId,
          transitionType: d.transitionType,
          url: d.url.slice(0, 300),
        }),
      ),
    );
    c.webNavigation.onErrorOccurred.addListener((d) =>
      console.log(
        "TEST webNavigation.onErrorOccurred",
        JSON.stringify({ tabId: d.tabId, error: d.error, url: d.url.slice(0, 300) }),
      ),
    );
    c.tabs.onCreated.addListener((tab) =>
      console.log(
        "TEST tabs.onCreated",
        JSON.stringify({ id: tab.id, url: (tab.pendingUrl || tab.url || "").slice(0, 200) }),
      ),
    );
    c.tabs.onRemoved.addListener((id) => console.log("TEST tabs.onRemoved", id));
    c.storage.onChanged.addListener((changes) => {
      const summary = Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [k, Object.keys(v || {})]),
      );
      console.log("TEST storage.onChanged", JSON.stringify(summary));
    });
    console.log("TEST listeners wired");
  });

  // --- open Google auth URL in a new tab ---------------------------------
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", PROJECT_CLIENT_ID);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");

  log("test", "opening auth URL:", authUrl.toString().slice(0, 120) + " …");
  const tabId = await sw.evaluate(
    (url) =>
      new Promise((resolve, reject) => {
        /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }, (tab) => {
          const err = /** @type {any} */ (globalThis).chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(tab.id);
        });
      }),
    authUrl.toString(),
  );
  log("test", "opened tab id:", tabId);
  log("test", "watching for 90s — complete Google consent in the browser …");

  await new Promise((r) => setTimeout(r, 90_000));

  log("test", "snapshot after 90s:");
  const finalStorage = await sw.evaluate(() =>
    /** @type {any} */ (globalThis).chrome.storage.local.get(null),
  );
  log("sw.storage", "final:", JSON.stringify(finalStorage).slice(0, 400));

  const remaining = await sw.evaluate(() => {
    const c = /** @type {any} */ (globalThis).chrome;
    return new Promise((resolve) =>
      c.tabs.query(
        { url: ["https://accounts.google.com/*", "*://*.chromiumapp.org/*"] },
        (tabs) => resolve(tabs.map((t) => ({ id: t.id, url: (t.url || "").slice(0, 200) }))),
      ),
    );
  });
  log("test", "auth-related tabs still open:", JSON.stringify(remaining));

  clearInterval(consolePoll);
  await browser.close();
  log("done");
}

main().catch((e) => {
  console.error("test-auth-flow crashed:", e);
  process.exit(1);
});
