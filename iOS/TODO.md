# iOS Safari extension: status and to-dos

Last updated: 2026-11-20 (v1.2.0)

## Where things stand

The Safari extension for iPhone and iPad uses the same `extension/` code as Chrome. The Xcode project (`iOS/Bonsai.xcodeproj`) copies those files into the app's Safari extension at build time, so there is no second copy to keep in sync.

The one real code change is sign-in. Chrome's flow relies on `chrome.identity` and `webRequest`, which Safari doesn't have; on Safari the background script would have crashed at startup. The extension now checks which browser it's in:

- Chrome: sign-in is unchanged.
- Safari: Google redirects to a new backend page, `/auth/safari-callback`. A small content script on that page passes the token to the extension and the tab closes.

The backend also accepts requests from Safari's extension origins (`safari-web-extension://...`), which differ on every install.

What has been verified:

- GitHub Actions on macOS ([first run](https://github.com/krjadhav/bonsai/actions/runs/44718869311)): the project builds for the iOS Simulator, all extension files land in the app with matching versions, the app installs and launches in an iPhone simulator, and the simulator registers Bonsai as a Safari extension. A screenshot of the app is in the run's artifacts.
- `npm run check` passes, including `check:safari`, which runs the background code with Safari's missing APIs removed and walks through sign-in. It fails if the old Chrome-only code comes back.
- Backend: ruff, pyrefly and pytest pass, including 3 new tests for the callback page and CORS.

Not verified yet: anything in real Safari. Sign-in, the x.com content script, and the background surviving iOS suspending it all need a test on a device.

## Action items

### Before sign-in can work on Safari

- [ ] In Google Cloud Console > APIs & Services > Credentials, open the existing OAuth client and add this authorized redirect URI: `https://bonsai-api-1000316385691.asia-south1.run.app/auth/safari-callback`
- [ ] Redeploy the backend so `/auth/safari-callback` and the Safari CORS rule are live. Check with `curl -I https://bonsai-api-1000316385691.asia-south1.run.app/auth/safari-callback` (expect 200).

### Run it on an iPhone (Mac with Xcode 16 or newer)

- [ ] Copy `iOS/Config/Local.xcconfig.example` to `iOS/Config/Local.xcconfig` and set `DEVELOPMENT_TEAM`. A free Apple ID works; the install expires after 7 days.
- [ ] Open `iOS/Bonsai.xcodeproj`, pick the Bonsai scheme and your phone, Product > Run. Enable Developer Mode on the phone if asked.
- [ ] In Safari: page menu > Manage Extensions > turn on Bonsai, then allow it on x.com.
- [ ] Sign in. Safari asks once more about the `bonsai-api...run.app` page; allow it, or the sign-in tab won't close.
- [ ] Check: a post gets the Yes/No controls, a decision reaches the backend, and things still work after leaving Safari idle for a few minutes.

### Decisions and follow-ups

- [ ] Root `AGENTS.md` still says `npm run check` has "five gates"; it now has six (`check:safari` was added). Update it if you want the docs to match.
- [ ] The default bundle ID is `app.bonsai.feedfilter`. If Xcode says it's taken, override `BONSAI_BUNDLE_ID` in `Local.xcconfig`.
- [ ] Decide whether to add a Mac version of the app (not built yet; see `iOS/AGENTS.md` > Packager reference).
- [ ] Watch GitHub Actions usage: the iOS build runs on a macOS machine (about 6 minutes) whenever `iOS/` or `extension/` changes. On a private repo, macOS minutes count 10x against the Actions quota.
- [ ] Before an App Store submission: check Guideline 4.8 (Sign in with Apple alongside Google sign-in) and write `iOS/APPSTORE.md` as described in `iOS/AGENTS.md`.
