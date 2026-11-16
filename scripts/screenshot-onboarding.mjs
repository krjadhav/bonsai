#!/usr/bin/env node
// @ts-check
/* global document, getComputedStyle */
// Opens onboarding.html in headless Chromium, forces the tour section
// visible so we can see each step (sign-in gate would hide it otherwise),
// and writes a PNG per step to .local/screenshots/ for the agent to inspect.

import puppeteer from "puppeteer";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = resolve(ROOT, "extension");
const OUT_DIR = resolve(ROOT, ".local/screenshots");
mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1200,900",
  ],
});

try {
  const deadline = Date.now() + 10_000;
  let swTarget = null;
  while (Date.now() < deadline) {
    swTarget = browser.targets().find((t) => t.type() === "service_worker");
    if (swTarget) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!swTarget) throw new Error("service worker did not register");
  const sw = await swTarget.worker();
  const extensionId = await sw.evaluate(
    () => globalThis.chrome.runtime.id,
  );

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extensionId}/onboarding.html`, {
    waitUntil: "load",
    timeout: 10_000,
  });

  // Force tour section visible (default state is sign-in gate).
  await page.evaluate(() => {
    const signedOut = document.getElementById("signedOut");
    const tour = document.getElementById("tour");
    if (signedOut) signedOut.hidden = true;
    if (tour) tour.hidden = false;
  });

  const debug = await page.evaluate(() => {
    const el = document.querySelector(".hint-arrow");
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    return {
      found: true,
      transform: cs.transform,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
      display: cs.display,
    };
  });
  console.log("hint-arrow computed:", debug);

  for (const step of [1, 2, 3]) {
    await page.evaluate((s) => {
      const stage = document.getElementById("tourStage");
      if (stage) stage.dataset.step = String(s);
    }, step);
    await new Promise((r) => setTimeout(r, 400));
    const out = resolve(OUT_DIR, `onboarding-tour-step${step}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log("wrote " + out);
  }
} finally {
  await browser.close();
}
