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

  /** @type {{ title: string, body: string }[]} */
  const TOUR_STEPS = [
    {
      title: "Rate what you see",
      body: "On every post on X, tap the thumb icons to mark it as more like this or less like this.",
    },
    {
      title: "Bonsai learns",
      body: "Your rated posts shape a preference model — more of what you want, less of what you don't.",
    },
    {
      title: "Your feed reshapes",
      body: "Over time the feed leans toward the posts you keep and quiets the ones you drop.",
    },
  ];

  let tourIndex = 0;

  /** @param {"signedOut" | "tour" | "home"} name */
  function showSection(name) {
    const views = /** @type {const} */ (["signedOut", "tour", "home"]);
    for (const v of views) $(v).hidden = v !== name;
  }

  function renderTour() {
    const step = TOUR_STEPS[tourIndex];
    $("tourStage").dataset.step = String(tourIndex + 1);
    $("tourTitle").textContent = step.title;
    $("tourBody").textContent = step.body;

    const dots = $("tourDots").querySelectorAll(".step-dot");
    dots.forEach((d, i) => d.classList.toggle("is-active", i === tourIndex));

    $("tourBackBtn").hidden = tourIndex === 0;
    $("tourNextBtn").textContent =
      tourIndex === TOUR_STEPS.length - 1 ? "Open X" : "Next";
  }

  async function refreshUI() {
    const store = await chrome.storage.local.get(["bonsaiUser", ONBOARDED_KEY]);
    const bonsaiUser = /** @type {BonsaiUser | undefined} */ (store.bonsaiUser);
    const onboarded = Boolean(store[ONBOARDED_KEY]);
    const signedIn = Boolean(bonsaiUser && bonsaiUser.email);

    $("headerSignOutBtn").hidden = !signedIn;

    if (!signedIn || !bonsaiUser) {
      showSection("signedOut");
      return;
    }

    $("userName").textContent = bonsaiUser.name || "Signed in";
    $("userEmail").textContent = bonsaiUser.email;
    if (bonsaiUser.picture) {
      /** @type {HTMLImageElement} */ ($("avatar")).src = bonsaiUser.picture;
    }

    if (!onboarded) {
      tourIndex = 0;
      renderTour();
      showSection("tour");
    } else {
      showSection("home");
    }
  }

  /**
   * Open Google's OAuth consent URL in a new tab. The service worker's
   * chrome.webNavigation.onBeforeNavigate listener catches the redirect
   * to <ext-id>.chromiumapp.org before DNS fires, extracts the access
   * token from the URL fragment, closes the tab, and stores the user.
   * No launchWebAuthFlow, no intermediate oauth.html — the simplest
   * path that actually works.
   */
  async function signIn() {
    const btn = /** @type {HTMLButtonElement} */ ($("signInBtn"));
    btn.disabled = true;
    try {
      const manifest = chrome.runtime.getManifest();
      const clientId = manifest.oauth2?.client_id;
      if (!clientId || clientId.startsWith("REPLACE_")) {
        throw new Error("oauth2.client_id missing or placeholder in manifest.json");
      }
      const scopes = (manifest.oauth2?.scopes || ["openid", "email", "profile"]).join(" ");
      const redirectUri = chrome.identity.getRedirectURL();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "token");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("include_granted_scopes", "true");
      authUrl.searchParams.set("prompt", "consent");
      await chrome.tabs.create({ url: authUrl.toString() });
      window.close();
    } catch (e) {
      const msg = /** @type {Error} */ (e)?.message || String(e);
      alert("Could not start sign-in: " + msg);
      btn.disabled = false;
    }
  }

  async function signOut() {
    // Service worker clears all storage + revokes the token. No need to
    // double-clear here — leaving the second remove() in creates a race
    // where the SW's clear() lands after this remove() and silently wipes
    // whatever the user did in between.
    await chrome.runtime.sendMessage({ type: "bonsai:signOut" });
    refreshUI();
  }

  async function openX() {
    await chrome.storage.local.set({ [ONBOARDED_KEY]: true });
    await chrome.tabs.create({ url: "https://x.com/home" });
    window.close();
  }

  function tourNext() {
    if (tourIndex < TOUR_STEPS.length - 1) {
      tourIndex += 1;
      renderTour();
    } else {
      openX();
    }
  }

  function tourBack() {
    if (tourIndex > 0) {
      tourIndex -= 1;
      renderTour();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const manifest = chrome.runtime.getManifest();
    $("verLabel").textContent = "v" + manifest.version;

    $("signInBtn").addEventListener("click", signIn);
    $("signOutBtn").addEventListener("click", signOut);
    $("headerSignOutBtn").addEventListener("click", signOut);
    $("openXBtn").addEventListener("click", openX);
    $("tourNextBtn").addEventListener("click", tourNext);
    $("tourBackBtn").addEventListener("click", tourBack);

    refreshUI();
  });
})();
