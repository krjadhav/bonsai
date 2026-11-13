#!/usr/bin/env node
// @ts-check
// Chromium load smoke test for the Bonsai extension.
//
// Launches bundled Chromium in headless mode with the unpacked extension
// loaded, then:
//   * Waits for the MV3 service worker to register and reports its errors.
//   * Opens the popup HTML directly (chrome-extension://<id>/popup.html)
//     and reports any errors or page errors from it.
//   * Opens the sidebar HTML the same way.
//
// Fails fast if any of the three contexts produces an Error-level console
// message or a thrown page error. This catches the bug class that lights up
// the red "Errors" button at chrome://extensions after a reload.

import puppeteer from "puppeteer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = resolve(ROOT, "extension");

/** @type {string[]} */
const failures = [];
/** @param {string} msg */
const fail = (msg) => {
  failures.push(msg);
  console.error("  ✗ " + msg);
};

/** @param {import("puppeteer").Page} page @param {string} label */
function wire(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error") fail(`[${label}] console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => {
    const msg = /** @type {Error} */ (e)?.message || String(e);
    fail(`[${label}] pageerror: ${msg}`);
  });
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText || "unknown";
    // chrome-extension:// requests for missing files show up here and are
    // usually the first symptom of a broken manifest reference.
    if (err !== "net::ERR_BLOCKED_BY_CLIENT") {
      fail(`[${label}] requestfailed ${req.url()} — ${err}`);
    }
  });
}

/** @param {import("puppeteer").Browser} browser */
async function waitForServiceWorker(browser) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targets = browser.targets();
    const sw = targets.find((t) => t.type() === "service_worker");
    if (sw) return sw;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main() {
  console.log("Launching Chromium with extension at " + EXT);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const swTarget = await waitForServiceWorker(browser);
    if (!swTarget) {
      fail("service worker never registered within 10s");
    } else {
      const sw = await swTarget.worker();
      if (sw) {
        sw.on("console", (m) => {
          if (m.type() === "error") fail(`[service-worker] ${m.text()}`);
        });
        // Let any onInstalled handlers finish synchronously.
        await new Promise((r) => setTimeout(r, 500));
        // Confirm the worker is reachable: ask it for the extension id.
        const extensionId = await sw.evaluate(
          () => /** @type {any} */ (globalThis).chrome.runtime.id,
        );
        console.log("Service worker up. Extension id: " + extensionId);

        // Load popup and sidebar via chrome-extension:// URL.
        const popup = await browser.newPage();
        wire(popup, "popup");
        await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
          waitUntil: "load",
          timeout: 10_000,
        });
        await new Promise((r) => setTimeout(r, 500));
        await popup.close();

        const sidebar = await browser.newPage();
        wire(sidebar, "sidebar");
        await sidebar.goto(`chrome-extension://${extensionId}/sidebar.html`, {
          waitUntil: "load",
          timeout: 10_000,
        });
        await new Promise((r) => setTimeout(r, 500));
        await sidebar.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\nChromium load smoke test: ${failures.length} error(s). See above.\n`);
    process.exit(1);
  }
  console.log("Chromium load smoke test OK — service worker + popup + sidebar loaded cleanly.");
}

main().catch((e) => {
  console.error("check-load crashed:", e);
  process.exit(1);
});
