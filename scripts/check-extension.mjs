#!/usr/bin/env node
// Preflight validator for the Chrome extension.
//
// Catches the common classes of breakage that only surface at runtime:
//   1. JS references DOM ids that don't exist in any HTML — the TypeError
//      source that keeps biting us (null.addEventListener / null.hidden).
//   2. manifest.json references files that don't exist on disk.
//   3. manifest.json version diverges from package.json version.
//   4. HTML ids collide across the same document.
//
// Exit 0 = ship it. Exit 1 = fix first. Keep this script dependency-free so
// it can run from prezip without touching node_modules.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");

const errors = [];
const warn = [];
const fail = (msg) => errors.push(msg);
const warnMsg = (msg) => warn.push(msg);

// ---------- helpers ----------
function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function read(path) {
  return readFileSync(path, "utf8");
}

function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

// ---------- 1. HTML id inventory + duplicate check ----------
const htmlFiles = walk(EXT, [".html"]);
const idsByFile = new Map(); // file -> Set<string>
const allIds = new Set();

for (const file of htmlFiles) {
  const src = read(file);
  const ids = new Set();
  const seen = new Map(); // id -> count
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const id = m[1];
    ids.add(id);
    seen.set(id, (seen.get(id) || 0) + 1);
    allIds.add(id);
  }
  for (const [id, count] of seen) {
    if (count > 1) fail(`[${relative(ROOT, file)}] duplicate id="${id}" (${count}x)`);
  }
  idsByFile.set(file, ids);
}

// ---------- 2. JS id reference + dynamic id injection check ----------
// Match getElementById("x"), document.querySelector('#x'), and $("x") where
// $ is the common popup helper. Anything stricter would miss real cases;
// anything looser would false-positive on jQuery-style queries.
//
// Also seed the known-id set from JS: elements can be built in script and
// given an id (e.g. el.id = "foo", or template literals containing id="foo").
// Those are legitimate targets even though they never appear in an .html file.
const jsFiles = walk(EXT, [".js"]);
const refs = []; // { file, id, line, source }

for (const file of jsFiles) {
  const src = read(file);

  // Seed dynamically-assigned ids.
  const assignRe = /\.id\s*=\s*["']([^"']+)["']/g;
  let am;
  while ((am = assignRe.exec(src)) !== null) allIds.add(am[1]);

  // Seed ids embedded in string/template literals (createElement + innerHTML).
  const inlineRe = /\bid\s*=\s*["']([A-Za-z_][\w-]*)["']/g;
  let im;
  while ((im = inlineRe.exec(src)) !== null) allIds.add(im[1]);

  const patterns = [
    { re: /getElementById\(\s*["']([^"']+)["']\s*\)/g, label: "getElementById" },
    { re: /querySelector(?:All)?\(\s*["']#([A-Za-z_][\w-]*)["']\s*\)/g, label: "querySelector#" },
    { re: /\$\(\s*["']([A-Za-z_][\w-]*)["']\s*\)/g, label: "$()" },
  ];
  for (const { re, label } of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      refs.push({ file, id: m[1], line: lineOf(src, m.index), source: label });
    }
  }
}

for (const r of refs) {
  if (!allIds.has(r.id)) {
    fail(`[${relative(ROOT, r.file)}:${r.line}] ${r.source}("${r.id}") — no matching id in any HTML`);
  }
}

// ---------- 3. manifest.json referenced-file existence ----------
const manifestPath = join(EXT, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(read(manifestPath));
} catch (e) {
  fail(`[extension/manifest.json] invalid JSON: ${e.message}`);
}

function checkPath(relPath, label) {
  if (!relPath || typeof relPath !== "string") return;
  const abs = join(EXT, relPath);
  if (!existsSync(abs)) fail(`[manifest.json ${label}] missing file: extension/${relPath}`);
}

if (manifest) {
  // Icons (top-level + action.default_icon)
  for (const [, p] of Object.entries(manifest.icons || {})) checkPath(p, "icons");
  for (const [, p] of Object.entries(manifest.action?.default_icon || {})) checkPath(p, "action.default_icon");

  // Popup HTML
  checkPath(manifest.action?.default_popup, "action.default_popup");

  // Background service worker
  checkPath(manifest.background?.service_worker, "background.service_worker");

  // Side panel
  checkPath(manifest.side_panel?.default_path, "side_panel.default_path");

  // Content scripts
  for (const cs of manifest.content_scripts || []) {
    for (const j of cs.js || []) checkPath(j, "content_scripts.js");
    for (const c of cs.css || []) checkPath(c, "content_scripts.css");
  }

  // Web accessible resources
  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) checkPath(r, "web_accessible_resources.resources");
  }

  // OAuth client id placeholder check
  const oauthClient = manifest.oauth2?.client_id || "";
  if (oauthClient.startsWith("REPLACE_")) {
    warnMsg(`[manifest.json] oauth2.client_id is a placeholder — sign-in will fail until replaced`);
  }
}

// ---------- 4. version sync ----------
const pkg = JSON.parse(read(join(ROOT, "package.json")));
if (manifest && pkg.version !== manifest.version) {
  fail(`version mismatch: package.json=${pkg.version} vs extension/manifest.json=${manifest.version}`);
}

// ---------- 5. HTML -> manifest popup script tag coherence ----------
// Loaded popup/sidebar HTML must reference scripts that live next to them.
for (const file of htmlFiles) {
  const src = read(file);
  const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const srcPath = m[1];
    if (/^https?:/.test(srcPath)) continue;
    const abs = resolve(dirname(file), srcPath);
    if (!existsSync(abs)) {
      fail(`[${relative(ROOT, file)}] <script src="${srcPath}"> — file not found`);
    }
  }
  const linkRe = /<link[^>]*\bhref\s*=\s*["']([^"']+\.css)["']/g;
  while ((m = linkRe.exec(src)) !== null) {
    const hrefPath = m[1];
    if (/^https?:/.test(hrefPath)) continue;
    const abs = resolve(dirname(file), hrefPath);
    if (!existsSync(abs)) {
      fail(`[${relative(ROOT, file)}] <link href="${hrefPath}"> — file not found`);
    }
  }
}

// ---------- report ----------
const label = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;

if (warn.length) {
  console.warn("\nWarnings:");
  for (const w of warn) console.warn("  ⚠  " + w);
}

if (errors.length) {
  console.error(`\nExtension preflight: ${label(errors.length, "error")}`);
  for (const e of errors) console.error("  ✗ " + e);
  console.error("");
  process.exit(1);
}

console.log(
  `Extension preflight OK — ${htmlFiles.length} html, ${jsFiles.length} js, ` +
    `${refs.length} id refs across ${allIds.size} ids.`,
);
