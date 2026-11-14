# Agent-agnostic instructions

## Development
- Use trunk-based development: commit directly to `main`, with no feature branch, PR, or review queue by default. Commit and push completed work to `origin` (`git push origin main`); this is standing authorization.
- Keep commits small, atomic, bisectable, and revertable. Split independent changes and use focused messages. Run relevant checks after each small change for fast feedback.
- If `main` breaks, fix it immediately or revert immediately if a safe fix is not ready, verify the recovery, and push it.
- When a branch is justified, keep it short-lived (hours, not days), fast-forward it into `main`, and delete it locally and remotely if pushed.
- Check status and fetch before integrating remote work. Preserve unrelated user edits; never force-push shared history or commit secrets.
- Do not update README.md and AGENT.md unless explicitly asked. By default write context to .local/

## Versioning

- Use `MAJOR.MINOR.PATCH`: breaking changes, compatible features, and compatible fixes respectively. Keep `package.json` and `package-lock.json` synchronized with `npm version <version> --no-git-tag-version`. Documentation-only changes may retain the current version; recovery must not silently downgrade it.
- Start every commit subject, including docs and reverts, with `vMAJOR.MINOR.PATCH`, followed by the skill's conventional type, optional scope, and summary. Example: `v0.2.1 fix(viewer): handle empty results`. This overrides the git-commit skill's type-first format; keep the subject within 72 characters.
- Read the version from `package.json` and display it at the top right on every deployed screen, including loading/error states and narrow viewports. Verify the displayed version; do not equate a push with a verified deployment.

## Local tools and skills
Read the relevant local instructions and use local commands first; routine use does not require web searches or update checks. If missing, install with the listed commands before proceeding. Upstream links are references for installation, troubleshooting, and intentional updates. Review updates, refresh local instructions, and run relevant checks; do not upgrade on every task.

### Design System: Meta Astryx

[Upstream guide](https://astryx.atmeta.com/docs/getting-started) · [Local generated conventions](.agents/astryx.md)

- **Matcha is the established default. Do not ask about look and feel or change the theme unless the user requests a different direction.**
- Read `.agents/astryx.md` before UI work. Use Astryx components, layout primitives, and tokens; discover component props and import paths through the CLI. Migrate existing surfaces incrementally.
- Keep the single root `<Theme theme={themes[defaultThemeSlug]}>` wired through `app/components/AppTheme.tsx` and generated `astryx-themes.ts`. Keep reset/base CSS loaded once and `app/layers.css` imported first. Do not hand-edit the generated theme module.
- Customize with `defineTheme({ extends: importedTheme, ... })`; use `theme eject` only when explicitly asked for an independent source fork.

Use Node >=22.13.0 (`nvm use`). Restore existing dependencies with `npm ci` if needed. For missing Astryx setup:

```sh
npm install @astryxdesign/core @stylexjs/stylex @astryxdesign/theme-matcha @astryxdesign/cli
npx @astryxdesign/cli init --agent-docs-path .agents/astryx.md
npx @astryxdesign/cli theme add matcha
```

Routine commands (use the installed CLI; read further commands in the local conventions):

```sh
npx --no-install @astryxdesign/cli docs
npx --no-install @astryxdesign/cli component <Name>
npx --no-install @astryxdesign/cli docs <topic>
npx --no-install @astryxdesign/cli doctor --built .next
```

When intentionally upgrading, update all installed `@astryxdesign/*` packages together to a compatible release, run `npx @astryxdesign/cli upgrade --from <old-core-version> --apply`, and regenerate `.agents/astryx.md` with the init command above.

### Versioning: Git commits

[Upstream skill](https://www.skills.sh/github/awesome-copilot/git-commit) · [Local skill](.agents/skills/git-commit/SKILL.md)

Read `.agents/skills/git-commit/SKILL.md` before committing; follow its diff review, focused staging, and safety checks. Apply this repository's version-first subject and direct-to-main commit/push rules.

If missing: `npx skills add https://github.com/github/awesome-copilot --skill git-commit --yes`.

### Chrome Extensions

[Chrome's coding-agent guide](https://developer.chrome.com/docs/extensions/ai/build-with-ai) · [Upstream skill](https://github.com/GoogleChrome/modern-web-guidance) · [Local skill](.agents/skills/chrome-extensions/SKILL.md)

Use both `chrome-extensions` and the companion `modern-web-guidance` skill. Load relevant companion references for performance, accessibility, modern Web APIs, and built-in AI; for AI features, account for hardware support, model downloads, security, and fallbacks.

For initial setup or an intentional migration to Chrome's recommended installer, run `npx modern-web-guidance@latest install --choose` and select the coding agents in use plus both skills. This installer manages automatic skill updates; adopting it is an explicit exception to the manual-update policy above. Review changed guidance before applying it. Until that migration, retain the existing locally installed skill. Restore missing skills with `npx skills add GoogleChrome/modern-web-guidance --skill chrome-extensions --yes`; use `--skill modern-web-guidance` instead for the companion skill.

Read `.agents/skills/chrome-extensions/SKILL.md` before any work on `extension/` — the skill covers Manifest V3 rules, service-worker lifetimes, content-script isolation, permission minimization, side panel vs popup choice, and Chrome Web Store publishing. Project specifics to keep in mind alongside the skill:

- Manifest V3 service worker — background work lives in `extension/background.js` (module). No persistent globals; re-hydrate state from `chrome.storage.local` on wake.
- Storage keys owned by this extension: `bonsaiUser`, `bonsaiCaptures`, `bonsaiConfig`, `bonsaiOnboarded`, `bonsaiCoachSeen`. Reuse these before adding new keys.
- Content script injects into `article[role="article"]` on x.com/twitter.com. Scope all injected UI with `#bonsai-*` ids and `.bonsai-*` classes — never reuse X's class names or you'll fight their styles.
- OAuth: dual-flow in `background.js`. Tries `chrome.identity.getAuthToken` first (nicer UX, requires a Chrome-extension OAuth client with matching Item ID and Chrome native sign-in enabled) and falls back to `chrome.identity.launchWebAuthFlow` (works everywhere, requires a Web-application OAuth client with an authorized `https://<extension-id>.chromiumapp.org/` redirect URI). Scopes: `openid email profile`. Never commit the actual OAuth client id into `manifest.json` on `main`.
- OAuth client setup lives in `OAUTH-SETUP.md` at the repo root, with Path A (Chrome-extension) and Path B (Web application) documented side by side. Both require pinning the extension ID first via `node scripts/pin-extension-id.mjs`, which writes a `extension-key.pem` (gitignored) and prints the `key` field for `manifest.json`. Google provides no CLI or API for creating OAuth clients — do not try to automate this via `gcloud`. Direct users at OAUTH-SETUP.md whenever sign-in fails with `redirect_uri_mismatch`, `invalid_client`, `access blocked`, `turned off browser signin`, or `bad client id`.
- Side panel (`sidebar.html`) is opened via `chrome.sidePanel.open({ windowId })` from a user gesture only; MV3 rejects async-opened panels.
- Verification: run the preflight check below, then use the browser workflow for extension behavior changes.

#### Preflight (five gates)

Before zipping, publishing, or asking the user to reload the extension:

```sh
npm run check
```

That script chains five gates in order; any one failing stops the run and fixes are required before the next gate even runs. `npm run zip` is wired to `prezip`, so release artifacts cannot be built with any gate red.

1. **`npm run preflight`** — `scripts/check-extension.mjs`, a dependency-free Node validator that:
   - Flags any DOM id referenced by JS (`getElementById`, `querySelector("#…")`, `$("…")`) with no matching `id="…"` in any extension HTML or dynamic creation site. Catches the `null.addEventListener` / `null.hidden` class of TypeError.
   - Verifies every `manifest.json` path (icons, popup, service worker, side panel, content scripts, web-accessible resources) exists.
   - Verifies `package.json` and `extension/manifest.json` versions match.
   - Verifies `<script src>` and `<link href>` in extension HTML resolve to real files.
   - Warns on placeholder `oauth2.client_id`.
2. **`npm run lint`** — ESLint flat config in `eslint.config.mjs`. Catches undeclared references, unused vars, empty blocks (except `catch`). Runs over `extension/` and `scripts/`.
3. **`npm run typecheck`** — `tsc --noEmit` against `tsconfig.json` with `checkJs: true` plus `noImplicitAny`, `strictFunctionTypes`, `noImplicitThis`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Each extension JS file opts in with `// @ts-check` and carries JSDoc types; ambient types live in `extension/globals.d.ts`. `strictNullChecks` is intentionally off — DOM queries are inherently nullable and the overhead of asserting non-null everywhere outweighs the catch.
4. **`npm run audit`** — `npm audit --omit=dev --audit-level=high`. Production deps only (this project ships zero at runtime, so this is a guard against accidentally depending on something vulnerable later). Dev-only vulnerabilities in puppeteer / ESLint / tsc are intentionally ignored here.
5. **`npm run check:load`** — `scripts/check-load.mjs` launches the bundled Chromium in headless mode with the unpacked extension loaded via `--load-extension`, waits for the MV3 service worker to register, then opens `popup.html` and `sidebar.html` as `chrome-extension://<id>/…` pages. Fails if any of those three contexts emits a `console.error` or throws a page error. This is what catches the red "Errors" button in `chrome://extensions` before the user ever reloads the extension.

Do not disable any gate to get a green run. Fix the root cause. If a check is wrong, fix the check.

#### Browser verification

Configure [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) using the client's supported configuration format. Its server command is `npx`, with arguments `-y`, `chrome-devtools-mcp@latest`, `--categoryExtensions`, and `--autoConnect`. The extensions flag enables extension tools; auto-connect uses an existing Chrome profile for built-in AI and sign-in testing. The `@latest` setup follows upstream releases; use a reviewed, pinned version if keeping tool updates manual.

Enable remote debugging at `chrome://inspect/#remote-debugging`, restart the agent after configuration changes, and have the browser user accept Chrome's connection prompt for each new browser session. Confirm extension tools are available; installing a DevTools skill alone does not configure the MCP server.

Load the unpacked `extension/`, reload it after changes, trigger the affected actions, and inspect the relevant popup, side panel, content script, and service worker. Check console errors and relevant network failures, including persistence after worker restart. If automation is unavailable, load unpacked via `chrome://extensions` with Developer mode enabled and inspect manually (`Inspect views → service worker`). Report which flows were verified and any browser checks still outstanding; static checks alone do not verify extension behavior.

#### Chrome Web Store metadata

When creating or changing extension functionality, create or maintain root `CHROMEWEBSTORE.md` using `.agents/skills/chrome-extensions/references/webstore/chromewebstore-template.md`. Keep listing copy, permission and host-permission justifications, privacy/data-use disclosures, version history, and asset readiness aligned with the actual manifest and code. Update relevant sections as features, permissions, data handling, or assets change, and record rejection fixes. Mark unknown publication details as pending instead of inventing them. Read the skill's pre-publish checklist before preparing a submission.

### Security: Cloudflare Security Audit

[Upstream skill](https://github.com/cloudflare/security-audit-skill) · [Local skill](.agents/skills/security-audit/SKILL.md)

Read `.agents/skills/security-audit/SKILL.md` for security work and follow its execution limits. Use guidance mode for focused work; run the complete audit workflow only for explicit audit/pen-test/comprehensive-review requests or requested report artifacts.

If missing: `npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --yes`.

For full audits, validate the generated artifacts as the skill directs (these commands validate reports; they do not run an audit):

```sh
node .agents/skills/security-audit/validate-coverage-ledger.cjs <audit-dir>/coverage-ledger.json
node .agents/skills/security-audit/validate-findings.cjs <audit-dir>/findings.json
```

## Verification

- Run `npm run typecheck` for TypeScript changes and `npm run build` for application/dependency changes, plus focused tests for changed behavior. For UI changes, inspect affected states at desktop/mobile widths and in light/dark modes, and run Astryx doctor above; resolve failures and inspect warnings.
- Before committing, run `git diff --check`. Documentation-only work needs an instructions/links review, not an application rebuild.
- Report changes, checks, commit/push results, and remaining limitations accurately.


# For Backend in Python
Commands
Lint:	```uv run ruff check .```
Format check: ```uv run ruff format --check .```
Auto-fix lint + format: ```uv run ruff check --fix . && uv run ruff format .```
Type-check: ```uv run pyrefly check```
Test (all): ```uv run pytest```
Test (single file): ```uv run pytest --capture=no <path>```
