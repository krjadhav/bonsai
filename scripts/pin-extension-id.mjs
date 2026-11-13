#!/usr/bin/env node
// Generate a dev keypair, derive the resulting Chrome extension ID, and
// emit the `key` field to paste into extension/manifest.json.
//
// Chrome derives the extension id from the SHA-256 of the DER-encoded public
// key, taking the first 32 bytes and mapping each hex nibble 0-f to a-p.
// Pinning the key makes the unpacked extension id deterministic, which is
// required for:
//   * The Chrome-extension OAuth client's "Item ID" field to match the
//     loaded extension (chrome.identity.getAuthToken client path).
//   * The Web-application OAuth client's authorized redirect URI
//     (https://<extension-id>.chromiumapp.org/) to stay valid across
//     unpacked reloads (chrome.identity.launchWebAuthFlow client path).
//
// Usage:
//   node scripts/pin-extension-id.mjs              # generate fresh keypair
//   node scripts/pin-extension-id.mjs path/to.pem  # reuse existing .pem
//
// Private key output lives in extension-key.pem (gitignored via *.pem).
// Public key is printed as the base64-DER `key` to paste into manifest.json.

import { generateKeyPairSync, createPublicKey, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const argPath = process.argv[2];
let privatePem;

if (argPath) {
  if (!existsSync(argPath)) {
    console.error(`No such file: ${argPath}`);
    process.exit(1);
  }
  privatePem = readFileSync(argPath, "utf8");
} else {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const outPath = resolve(process.cwd(), "extension-key.pem");
  writeFileSync(outPath, privatePem, { mode: 0o600 });
  console.log(`Generated new key → ${outPath}`);
  console.log(`(gitignored via *.pem — never commit this file)`);
  console.log();
}

const publicKey = createPublicKey(privatePem);
const der = publicKey.export({ type: "spki", format: "der" });
const base64Der = der.toString("base64");

// Extension id: first 32 hex chars of SHA-256(DER public key), then remap
// 0-9 → a-j and a-f → k-p.
const hash = createHash("sha256").update(der).digest("hex").slice(0, 32);
const id = hash
  .split("")
  .map((c) => String.fromCharCode(c.charCodeAt(0) + (/[0-9]/.test(c) ? 49 : 10)))
  .join("");

console.log("Extension id (pinned):");
console.log("  " + id);
console.log();
console.log("Paste into extension/manifest.json at the top level:");
console.log();
console.log('  "key": "' + base64Der + '",');
console.log();
console.log("Then in Google Cloud Console:");
console.log(
  "  * Chrome-extension client → set Item ID to:  " + id,
);
console.log(
  "  * Web-application client → add Authorized redirect URI:",
);
console.log("      https://" + id + ".chromiumapp.org/");
