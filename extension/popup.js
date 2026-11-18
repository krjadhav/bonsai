// @ts-check
(() => {
  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not in popup DOM`);
    return el;
  };

  const ONBOARDED_KEY = "bonsaiOnboarded";
  const USER_KEY = "bonsaiUser";
  const PENDING_KEY = "bonsaiPending";

  /** @param {"setup" | "home" | "stale"} name */
  function showSection(name) {
    const views = /** @type {const} */ (["setup", "home", "stale"]);
    for (const v of views) $(v).hidden = v !== name;
  }

  async function refreshUI() {
    const store = await chrome.storage.local.get([USER_KEY, ONBOARDED_KEY, PENDING_KEY]);
    const user = /** @type {BonsaiUser | undefined} */ (store[USER_KEY]);
    const onboarded = Boolean(store[ONBOARDED_KEY]);
    const signedIn = Boolean(user && user.email);
    const pending = /** @type {BonsaiCapture[]} */ (store[PENDING_KEY] || []);

    $("headerSignOutBtn").hidden = !signedIn;

    // Stale wins over setup/home. User explicitly needs to re-authenticate;
    // nudge them with the unsynced count so the risk of signing out before
    // re-signing in is visible.
    if (user?.stale) {
      const note = /** @type {HTMLElement} */ ($("stalePendingNote"));
      if (pending.length > 0) {
        note.textContent = `${pending.length} rating${pending.length === 1 ? "" : "s"} waiting to sync.`;
        note.hidden = false;
      } else {
        note.hidden = true;
      }
      showSection("stale");
      return;
    }

    if (!signedIn || !onboarded) {
      $("setupLead").innerHTML = signedIn
        ? "You're signed in. Finish the quick tour to start pruning."
        : "Teach your feed what you want to see.<br />Finish setup to start pruning.";
      showSection("setup");
      return;
    }

    if (user) {
      $("userName").textContent = user.name || "Signed in";
      $("userEmail").textContent = user.email;
      if (user.picture) {
        /** @type {HTMLImageElement} */ ($("avatar")).src = user.picture;
      }
    }
    showSection("home");
  }

  async function openOnboarding() {
    const url = chrome.runtime.getURL("onboarding.html");
    // Focus an existing onboarding tab if one is already open.
    const existing = await chrome.tabs.query({ url });
    if (existing.length && existing[0].id !== undefined) {
      await chrome.tabs.update(existing[0].id, { active: true });
      if (existing[0].windowId !== undefined) {
        await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
      }
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  }

  async function signOut() {
    await chrome.runtime.sendMessage({ type: "bonsai:signOut" });
    refreshUI();
  }

  async function openX() {
    await chrome.tabs.create({ url: "https://x.com/home" });
    window.close();
  }

  // The "Sign in again" button fires on a user gesture so it can take the
  // interactive path immediately (matches the first-run onboarding sign-in
  // flow). Silent prompt=none is handled by background.js alarms; this is
  // the explicit fallback the user sees when that silent path has failed.
  async function reauth() {
    await openOnboarding();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const manifest = chrome.runtime.getManifest();
    $("verLabel").textContent = "v" + manifest.version;

    $("openOnboardingBtn").addEventListener("click", openOnboarding);
    $("reauthBtn").addEventListener("click", reauth);
    $("signOutBtn").addEventListener("click", signOut);
    $("headerSignOutBtn").addEventListener("click", signOut);
    $("openXBtn").addEventListener("click", openX);

    refreshUI();
  });
})();
