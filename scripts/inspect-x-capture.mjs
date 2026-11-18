#!/usr/bin/env node
// @ts-nocheck
// Launch a headed Chromium with the Bonsai extension loaded against a
// persistent profile in .local/x-inspect-profile/, navigate to each URL
// supplied on the command line, wait for the extension to attach its
// thumbs row to the article, then read what extractTweet produced by
// querying chrome.storage.local from the service worker.
//
// First run: the Chromium window will show X asking you to sign in. Sign
// in once, close the window, re-run. Subsequent runs reuse cookies.
//
// Usage:
//   node scripts/inspect-x-capture.mjs \
//     https://x.com/snatchTheM0ment/status/2122949347394633749 \
//     https://x.com/shreyas/status/2056893947285586015

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXT_PATH = path.join(REPO_ROOT, "extension");
const PROFILE_DIR = path.join(REPO_ROOT, ".local/x-inspect-profile");

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error("usage: node scripts/inspect-x-capture.mjs <url> [<url>...]");
    process.exit(1);
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chromium",
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  // Prevent the extension from trying to POST captures to prod during
  // inspection — no Google token stored in this profile, but belt-and-
  // braces by pointing apiBaseUrl at an unroutable host.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    sw = await ctx.waitForEvent("serviceworker");
  }
  await sw.evaluate(() =>
    chrome.storage.local.set({ bonsaiConfig: { apiBaseUrl: "http://127.0.0.1:1/" } }),
  );
  await sw.evaluate(() => chrome.storage.local.remove(["bonsaiCaptures", "bonsaiPending"]));

  for (const url of urls) {
    console.log("\n=== " + url + " ===");
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Bail if X redirects to the login wall
    const current = page.url();
    if (/\/login|\/i\/flow\/login/.test(current)) {
      console.log("auth required — log in in the window, then re-run");
      await page.waitForURL((u) => !/\/login|\/i\/flow\/login/.test(String(u)), {
        timeout: 5 * 60 * 1000,
      });
    }

    // Poll the article count — X single-tweet SSR often lands without an
    // `<article role="article">` element and promotes a `div` to it after
    // client hydration. Report what we see every few seconds so we can
    // tell "took a long time" apart from "never showed up".
    for (let s = 0; s < 45; s += 5) {
      const c = await page.locator('article[role="article"]').count();
      const anyArt = await page.locator("article").count();
      console.log(`t+${s}s article[role=article]=${c} any article=${anyArt}`);
      if (c > 0) break;
      await page.waitForTimeout(5000);
    }

    // Wait for the bonsai thumbs to render — signals extractTweet ran.
    try {
      await page.waitForSelector(".bonsai-thumb--yes", { timeout: 15_000 });
    } catch {
      console.log("timed out waiting for .bonsai-thumb--yes");
      console.log("page url:", page.url());
      console.log("page title:", await page.title());
      const articleCount = await page.locator('article[role="article"]').count();
      console.log("article[role=article] count:", articleCount);
      if (articleCount > 0) {
        const html = await page
          .locator('article[role="article"]')
          .first()
          .evaluate((el) => el.outerHTML);
        console.log("article outerHTML (first 2000 chars):\n" + html.slice(0, 2000));
      } else {
        const anyArts = await page.locator("article").count();
        console.log("any <article> count:", anyArts);
        for (let i = 0; i < anyArts; i++) {
          const attrs = await page.locator("article").nth(i).evaluate((el) => {
            const a = {};
            for (const n of el.getAttributeNames()) a[n] = el.getAttribute(n);
            return { attrs: a, childTestIds: Array.from(el.querySelectorAll("[data-testid]")).slice(0, 15).map(e => e.getAttribute("data-testid")) };
          });
          console.log(`article[${i}]:`, JSON.stringify(attrs));
        }
      }
      await page.close();
      continue;
    }

    // Click Yes on the first article to force persistDecision to run.
    await page.locator(".bonsai-thumb--yes").first().click();
    await page.waitForTimeout(500);

    const store = await sw.evaluate(async () => {
      const s = await chrome.storage.local.get(["bonsaiCaptures", "bonsaiPending"]);
      return s;
    });
    console.log(JSON.stringify(store.bonsaiCaptures?.[0] || null, null, 2));
    await page.close();
  }

  console.log("\nkeeping the browser open for 10s so you can inspect if needed");
  await new Promise((r) => setTimeout(r, 10_000));
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
