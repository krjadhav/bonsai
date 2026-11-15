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

  /** @param {"setup" | "home"} name */
  function showSection(name) {
    const views = /** @type {const} */ (["setup", "home"]);
    for (const v of views) $(v).hidden = v !== name;
  }

  async function refreshUI() {
    const store = await chrome.storage.local.get([USER_KEY, ONBOARDED_KEY]);
    const user = /** @type {BonsaiUser | undefined} */ (store[USER_KEY]);
    const onboarded = Boolean(store[ONBOARDED_KEY]);
    const signedIn = Boolean(user && user.email);

    $("headerSignOutBtn").hidden = !signedIn;

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

  document.addEventListener("DOMContentLoaded", () => {
    const manifest = chrome.runtime.getManifest();
    $("verLabel").textContent = "v" + manifest.version;

    $("openOnboardingBtn").addEventListener("click", openOnboarding);
    $("signOutBtn").addEventListener("click", signOut);
    $("headerSignOutBtn").addEventListener("click", signOut);
    $("openXBtn").addEventListener("click", openX);

    refreshUI();
  });
})();
