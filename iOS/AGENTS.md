# Safari Web Extension (iOS, iPadOS, macOS)

Instructions for agents working in `iOS/`. This folder holds the Xcode project that packages the existing Chrome extension in `../extension/` as a Safari Web Extension for iPhone and iPad. The root `AGENTS.md` still applies (versioning, commit format, verification reporting). Where the two conflict for files under `iOS/`, this file wins.

Last researched: 2026-11-20. Sources are listed at the bottom. Apple changes Safari extension support every release, so re-check the compatibility page before relying on a version number below.

## Ground rules

- `../extension/` is the single source of truth for JS, HTML, CSS and icons. Do not fork extension code into `iOS/`. Safari-specific behaviour goes behind feature detection in the shared code, or in a small Safari-only file that the shared manifest loads.
- The appex gets the web extension from a "Copy Web Extension" script phase that rsyncs `../extension/` (minus `*.d.ts`) into the bundle at build time. New files in `extension/` ship without touching the project. Never copy extension files into `iOS/`.
- Keep `manifest.json` version, `package.json` version, and `MARKETING_VERSION` in `Config/Base.xcconfig` identical. `npm run version:sync` writes all three and `npm run preflight` fails on a mismatch. Bump `CURRENT_PROJECT_VERSION` (build number) on every App Store Connect upload; it must be higher than the last uploaded build.
- Never commit signing material: `*.p12`, `*.mobileprovision`, `*.cer`, App Store Connect API keys, or a `DEVELOPMENT_TEAM`. Team id and any bundle id override go in the git-ignored `Config/Local.xcconfig` (template: `Config/Local.xcconfig.example`). If Xcode's Signing tab writes `DEVELOPMENT_TEAM` into `project.pbxproj`, don't commit that hunk. Keep `xcuserdata/` and `DerivedData/` out of git (see `iOS/.gitignore`).
- Xcode, the iOS Simulator and device installs only run on macOS. In a Linux container, edit files, run `npm run check` (which includes the Safari sign-in smoke test), and use the `iOS Safari extension` GitHub Actions workflow (`.github/workflows/ios.yml`) to build, install and launch in a simulator. Neither proves the extension works in Safari; say so in your report.

## Project layout

```
iOS/
  Bonsai.xcodeproj/          hand-maintained, objectVersion 60 (Xcode 15+), shared scheme "Bonsai"
  Bonsai/                    containing app: SwiftUI setup screen + Assets.xcassets (AppIcon, AccentColor)
  Bonsai Extension/          SafariWebExtensionHandler.swift + Info.plist (NSExtension point)
  Config/Base.xcconfig       MARKETING_VERSION, CURRENT_PROJECT_VERSION, BONSAI_BUNDLE_ID
  Config/Local.xcconfig      git-ignored: DEVELOPMENT_TEAM, optional BONSAI_BUNDLE_ID override
```

- Targets: `Bonsai` (iOS app, `$(BONSAI_BUNDLE_ID)`) embeds `Bonsai Extension` (`$(BONSAI_BUNDLE_ID).Extension`). Deployment target iOS 18.0, iPhone and iPad.
- The app screen shows the version at the top right, per the root versioning rule.
- The project was written by hand rather than by the packager, so it has no macOS target. To add macOS later, run the packager with `--macos-only --project-location` into a scratch folder and port its macOS target over, or rebuild the project with `--rebuild-project`. Expect to redo the copy phase either way.

## Testing on an iPhone

1. On a Mac with Xcode 16 or newer: `cp iOS/Config/Local.xcconfig.example iOS/Config/Local.xcconfig` and set `DEVELOPMENT_TEAM`. A free Apple ID works for your own device; the install expires after 7 days.
2. Open `iOS/Bonsai.xcodeproj`, pick the `Bonsai` scheme and your iPhone, Product > Run. The first time, enable Developer Mode on the phone (Settings > Privacy & Security) and trust the developer certificate if asked.
3. On the phone: Safari > page menu > Manage Extensions > turn on Bonsai. Then open x.com, tap Bonsai in the page menu and allow it on x.com. The welcome tab opens on first enable.
4. Sign in. Safari asks once more for access to the Bonsai API sign-in page (`bonsai-api-...run.app`); allow it, or the sign-in tab stays open.

One-time setup outside the repo, before step 4 works:

- Google Cloud Console > APIs & Services > Credentials > the OAuth client in `extension/oauth-config.js` > Authorized redirect URIs: add `https://bonsai-api-1000316385691.asia-south1.run.app/auth/safari-callback`.
- Redeploy the backend so `/auth/safari-callback` and the Safari CORS rule are live (`curl -I <api>/auth/safari-callback` returns 200).

## Packager reference

The current project is hand-written (see Project layout). These commands are for adding macOS or comparing against Apple's template. Run on a Mac with current Xcode, from the repo root:

```sh
xcrun safari-web-extension-packager extension \
  --project-location iOS \
  --app-name "Bonsai" \
  --bundle-identifier <reverse-dns-id> \
  --swift \
  --no-open
```

- Omit `--ios-only` / `--macos-only` to get both targets. One App Store Connect record covering iOS and macOS also ships to iPad and, as a compatible app, Vision Pro.
- The packager prints manifest keys the installed Safari ignores. Paste that list into the PR or commit notes and resolve each item using the compatibility section below.
- To add a platform to an existing project later: `xcrun safari-web-extension-packager --rebuild-project iOS/Bonsai.xcodeproj`.
- The tool was previously named `safari-web-extension-converter`. Older guides use that name.
- App Store Connect also hosts a web-based packager. Prefer the CLI so the project lives in git and is reproducible.

## Manifest rules for Safari

- Keep Manifest V3. On iOS the background context must be non-persistent; MV3 background is always non-persistent, so never add `"persistent": true`.
- Treat the background service worker as disposable. iOS suspends it aggressively and has had bugs where it stopped waking for messages (iOS 17.4 to 17.6, with reports continuing into 18). Persist every state change to `storage.local` immediately, re-register listeners at top level, and never keep auth or queue state only in module variables.
- If service-worker behaviour is unreliable on the minimum iOS version you target, Safari also accepts a non-persistent background page (`"background": { "scripts": [...] }`). Chrome MV3 does not, so this needs a per-browser manifest at build time. Decide this explicitly; don't let it happen by accident.
- Set `browser_specific_settings.safari.strict_min_version` to the oldest Safari you actually test on.
- `oauth2`, `update_url`, and `key` are Chrome-only and ignored by Safari. Updates ship through the App Store.
- `externally_connectable` works from Safari 15.4, but `ids` is not supported.
- Safari ignores `file://` patterns in permissions.

## Permissions model

Safari never grants host access automatically, even for hosts in `host_permissions`. The user sees a badge on the extension button and must grant access per site (once, for a day, or always on macOS; via the extension's entry in the More menu on iOS). They can revoke it later in Settings > Safari > Extensions.

What this means for Bonsai:

- The content script on `x.com` does nothing until the user grants access. Onboarding must tell the user to tap the extension icon and allow x.com, and the popup should detect missing access (`browser.permissions.contains`) and explain how to fix it. Don't show a generic error.
- The `*.run.app` API hosts need host access for `fetch` from the background. Keep the list as narrow as possible: list the exact API hostnames instead of `https://*.run.app/*`. A wildcard over all of Cloud Run reads badly in the permission prompt and in App Review.
- Prefer `activeTab` and `optional_host_permissions` + `browser.permissions.request()` over broad host patterns.
- In Safari 17+, a site grant applies across all profiles and private browsing.

## API compatibility checklist for this codebase

Audit of the `chrome.*` calls in `../extension/` against Apple's compatibility page. Safari supports both `chrome.*` and `browser.*`, and both callbacks and promises, so namespace changes are not required.

| Bonsai uses | Safari status | Action |
| --- | --- | --- |
| `chrome.identity.getAuthToken`, `launchWebAuthFlow`, `getRedirectURL` | Not supported. Apple says to start the OAuth flow in a new tab. | Done: `oauth-config.js` feature-detects and uses the API callback page. See below. |
| `chrome.webRequest.onBeforeRequest` | Not supported on iOS. macOS: observe-only, no blocking, no `opt_extraInfoSpec`. Non-persistent background content had webRequest listener problems after Safari 18.4. | Done: only registered on Chrome. Do not depend on it for new flows. |
| `chrome.webNavigation.onBeforeNavigate` | Supported (16+). `onHistoryStateUpdated`, `onCreatedNavigationTarget`, `onReferenceFragmentUpdated`, `onTabReplaced`, `transitionType` are not. | OK. Don't rely on history-state events for X's SPA routing; keep the content script's own URL observer. |
| `chrome.windows.update` | `windows.create/remove/update` not supported on iOS. | Already wrapped in `.catch()` in `popup.js`. Keep it optional. |
| `chrome.tabs.query({ url })` | Reading tab `url` needs host permission for that site. | Expect empty results before the user grants x.com access. |
| `chrome.tabs.create/update/remove` | Supported. | OK. |
| `chrome.storage.local` | 5 MB unless `unlimitedStorage` is declared. | Add `unlimitedStorage` if the capture queue can grow. |
| `chrome.storage.sync` | API exists but does not sync. | Don't use it for anything that must reach another device. |
| `chrome.storage.session` | Safari 16.4+. In memory, lost on restart. | Fine for caches only. |
| `chrome.alarms`, `chrome.action` badge/title, `chrome.runtime.*` messaging, `onInstalled`, `onStartup` | Supported. `runtime.setUninstallURL` is not. | Test that alarms still fire after iOS suspends the worker. |
| `contextMenus` / `menus` | Not supported on iOS. | Don't add features that depend on them. |
| `scripting.registerContentScripts` | Safari 16.4+. Registrations survive restarts but not extension updates. | If adopted, re-register in `runtime.onInstalled` when `reason === "update"`. |
| `tabs.executeScript` / `scripting.executeScript` | `allFrames`, `frameIds`, `injectImmediately`, `matchAboutBlank`, `runAt` not supported. | Use manifest content scripts. |

When adding a new API, check it on Apple's compatibility page and MDN's browser-compat data, add a row here, and feature-detect at runtime (`if (chrome.webRequest?.onBeforeRequest) ...`).

### Sign-in on Safari

Chrome opens Google OAuth, catches the 302 to `<ext-id>.chromiumapp.org` with `webRequest.onBeforeRequest`, and reads the token from the URL fragment. Safari has no `identity`, `chromiumapp.org` means nothing there, and iOS has no webRequest. What the shared code does instead:

1. `extension/oauth-config.js` checks for `chrome.identity.getRedirectURL`. If it's missing, the redirect URI is `https://<api>/auth/safari-callback`, served by `backend/bonsai/main.py` as a static page with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a CSP that allows no scripts.
2. Google sends the token in the fragment, which never reaches the server. `extension/oauth-callback.js` (a content script matched only on that path) strips the fragment from the address bar and sends the URL to the background as `bonsai:oauthRedirect`.
3. The background accepts the message only on Safari, only from its own extension id, only from a tab, and only if the URL starts with the redirect URI. Then the same `handleRedirectUrl` as Chrome stores the user and closes the tab. Silent reauth (`prompt=none`) uses the same path.
4. `npm run check:safari` runs `background.js` with a fake `chrome` that lacks `identity` and `webRequest` and checks this whole path, including rejecting spoofed messages.

This keeps parity with Chrome's implicit flow (access token in the fragment). A later hardening step is authorization code + PKCE with the exchange on the backend; do it for both browsers at once.

Safari's extension origin (`safari-web-extension://<UUID>`) differs per install, so it can't be listed in `ALLOWED_ORIGINS` or used as an OAuth redirect. The backend accepts any `safari-web-extension://` origin through `allow_origin_regex`. That's safe because requests authenticate with a bearer token and CORS is configured without credentials.

App Review: Guideline 4.8 (Login Services) may require offering Sign in with Apple when an app offers Google sign-in for the primary account. Check the current guideline text before submitting and record the decision in `iOS/APPSTORE.md`.

## Native app and messaging

- The generated containing app only needs to explain how to enable the extension (Settings > Safari > Extensions, or the More menu > Extensions in Safari) and link to privacy info. Keep it minimal. A bare app shell can still be rejected under Guideline 4.2 (minimum functionality), so give it a real onboarding screen with screenshots of the enable steps.
- Messaging needs the `nativeMessaging` permission. Only the background and extension pages can call `sendNativeMessage`. Safari ignores the application id argument and always routes to the containing app's extension handler.
- Handle messages in the generated `SafariWebExtensionHandler.beginRequest(with:)`. Read the payload from `SFExtensionMessageKey`, always call `context.completeRequest`, including on errors, and in Safari 17+ read `SFExtensionProfileKey` if data must be scoped per profile.
- App-to-JS messages (`SFSafariApplication.dispatchMessage` + `runtime.connectNative`) work on macOS only.
- The app and the extension run in separate sandboxes. Share data through an App Group container (`UserDefaults(suiteName:)`), never by assuming a shared file path.

## Running and debugging

- Fast loop on macOS without Xcode: Safari > Settings > Advanced > "Show features for web developers", then Settings > Developer > "Add Temporary Extension..." and pick `extension/`. Temporary extensions are removed after 24 hours or when Safari quits. "Allow unsigned extensions" also resets on quit.
- iOS: select the iOS app scheme, pick a simulator or a device, Product > Run. Then enable the extension in Safari (More menu > Extensions) and grant x.com access. Simulators work without an Apple Developer Program membership; devices need one.
- Web Inspector on iOS: on the device enable Settings > Safari > Advanced > Web Inspector, connect it to the Mac, then use Safari's Develop menu on the Mac. Content scripts are under Sources > Extension Scripts. Pick the extension's execution context in the lower-right selector. The background shows as "Extension Background Page/Content". The popup shows as "Extension Popup Page".
- Manifest errors are shown in iOS Safari's extension settings only for debug builds run from Xcode, not TestFlight or App Store builds.
- Native side: log with `print`/`os_log` and read them in Console.app filtered by the extension's name. `pluginkit -mAvvv -p com.apple.Safari.web-extension` lists the extensions macOS Safari can see.
- If the extension doesn't appear: the app and extension targets must have the same deployment target, and it must be at or below the OS version you're testing on.

### Verification an agent must report

Static checks (`npm run check` at the root) still gate the shared code. On top of that, for any change touching Safari behaviour, report which of these you actually ran:

1. The `iOS Safari extension` workflow is green for the pushed commit (build, appex contents, version match, simulator install and launch).
2. Locally on a Mac: `xcodebuild -project iOS/Bonsai.xcodeproj -scheme Bonsai -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` succeeds.
3. In the simulator: extension enabled, x.com access granted, onboarding completes, sign-in completes, a tweet gets the Yes/No controls, and a capture reaches the backend.
4. Force-quit Safari or leave it idle for several minutes, return, and confirm the background still answers messages and alarms still fire.
5. Same flow in macOS Safari (temporary extension is enough).

If you couldn't run steps 2 to 5 (for example, no Mac attached), say so plainly.

## Distribution

- App Store Connect: one app record, platforms iOS and macOS, bundle id matching the Xcode project. Ship betas through TestFlight first.
- Archive in Xcode (Product > Archive), bump the build number, and upload through Organizer, or use `xcodebuild archive` + `xcodebuild -exportArchive` in CI.
- You can't submit a zip of a Safari extension on its own. It always ships inside the containing app.
- Keep `iOS/APPSTORE.md` in sync with the real manifest and code, the same way the root guide requires for `CHROMEWEBSTORE.md`: description, screenshots per device class, privacy nutrition labels (Bonsai sends tweet text and the user's email to its backend, so declare that), the privacy policy URL, the review notes explaining how to enable the extension and grant x.com access, and the sign-in decision above. Mark unknowns as pending; don't invent them.

## Sources

- Apple: [Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- Apple: [Assessing your Safari web extension's browser compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)
- Apple: [Managing Safari web extension permissions](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
- Apple: [Messaging between the app and JavaScript in a Safari web extension](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
- Apple: [Running your Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
- Apple: [Troubleshooting your Safari web extension](https://developer.apple.com/documentation/safariservices/troubleshooting-your-safari-web-extension)
- WWDC26 session 216, "Create web extensions for Safari" (third-party notes): [ivan-magda/wwdc26-notes](https://github.com/ivan-magda/wwdc26-notes/blob/main/sessions/216-web-extensions-safari/digest.md)
- WebKit: [Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) (declarativeNetRequest fixes)
- Apple Developer Forums: [service worker killed on iOS 17.4 to 17.6](https://developer.apple.com/forums/thread/758346), [background script on Safari web extensions](https://developer.apple.com/forums/thread/709349)
- MDN: [manifest.json background](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) and browser-compat tables
