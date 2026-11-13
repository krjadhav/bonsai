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
  const COACH_KEY = "bonsaiCoachSeen";

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

  async function signIn() {
    const btn = /** @type {HTMLButtonElement} */ ($("signInBtn"));
    btn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "bonsai:signIn" });
      if (resp && resp.error) {
        const looksLikeConfig =
          /redirect_uri|invalid_client|Authorization page|invalid request|turned off browser signin|bad client id|OAuth2/i.test(
            resp.error,
          );
        let hint = "";
        if (looksLikeConfig) {
          const redirectUri = chrome.identity.getRedirectURL();
          const extId = chrome.runtime.id;
          hint =
            `\n\nExtension id:  ${extId}` +
            `\nRedirect URI:  ${redirectUri}` +
            `\n\nPick ONE OAuth client path in Cloud Console (project bonsai-feed-filter):` +
            `\n  A) Chrome-extension client → set Item ID = ${extId} and enable Chrome signin.` +
            `\n  B) Web-application client → add Authorized redirect URI = ${redirectUri}` +
            `\n\nFull walkthrough: OAUTH-SETUP.md.`;
        }
        alert("Sign-in failed: " + resp.error + hint);
      }
    } finally {
      btn.disabled = false;
      refreshUI();
    }
  }

  async function signOut() {
    await chrome.runtime.sendMessage({ type: "bonsai:signOut" });
    await chrome.storage.local.remove(["bonsaiUser", ONBOARDED_KEY, COACH_KEY]);
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
    $("openXBtn").addEventListener("click", openX);
    $("tourNextBtn").addEventListener("click", tourNext);
    $("tourBackBtn").addEventListener("click", tourBack);

    refreshUI();
  });
})();
