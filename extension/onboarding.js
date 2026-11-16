// @ts-check
// Bonsai onboarding page. Opened in a new tab on install so the user does
// not need to pin the extension to complete setup.
(() => {
  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not in onboarding DOM`);
    return el;
  };

  const ONBOARDED_KEY = "bonsaiOnboarded";
  const USER_KEY = "bonsaiUser";

  /** @type {{ title: string, body: string }[]} */
  const TOUR_STEPS = [
    {
      title: "Rate what you want to see",
      body: "",
    },
    {
      title: "Bonsai learns",
      body: "",
    },
    {
      title: "Your feed heals",
      body: "",
    },
  ];

  let tourIndex = 0;

  /** @param {"signedOut" | "tour"} name */
  function showSection(name) {
    const views = /** @type {const} */ (["signedOut", "tour"]);
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
      tourIndex === TOUR_STEPS.length - 1 ? "Open X and start rating" : "Next";
    updateNextGate();

    if (tourIndex === 1) restartSignalBloom();
    if (tourIndex === 2) restartQuietFeed();
    else stopQuietFeed();
  }

  // The signal-bloom animation is a long (8s) multi-layer loop. Without a
  // reset, the user usually lands on step 2 mid-cycle and only sees the fade
  // phase. Replacing the node with a fresh clone forces every CSS animation
  // to restart at frame 0.
  function restartSignalBloom() {
    const el = document.querySelector(".signal-bloom");
    if (!el || !el.parentNode) return;
    el.parentNode.replaceChild(el.cloneNode(true), el);
  }

  // ---- Quiet-feed animation (step 3) ----
  // CSS scrolls one row per cycle; JS picks a random visible row, hides it,
  // recycles it to the bottom once the scroll iteration lands, and restarts
  // the pick timer. Lifted from quiet-feed.html with the symbol prefix
  // renamed so it doesn't collide with other inline SVGs.
  let quietFeedTimer = 0;
  let quietFeedActive = /** @type {HTMLElement | null} */ (null);
  const quietFeedBetween = (/** @type {number} */ min, /** @type {number} */ max) =>
    min + Math.random() * (max - min);

  function stopQuietFeed() {
    if (quietFeedTimer) {
      clearTimeout(quietFeedTimer);
      quietFeedTimer = 0;
    }
    if (quietFeedActive) {
      quietFeedActive.classList.remove("is-hiding");
      quietFeedActive = null;
    }
  }

  function restartQuietFeed() {
    const existing = document.getElementById("quietFeed");
    if (!existing || !existing.parentNode) return;
    stopQuietFeed();
    const fresh = /** @type {HTMLElement} */ (existing.cloneNode(true));
    existing.parentNode.replaceChild(fresh, existing);
    initQuietFeed(fresh);
  }

  /** @param {HTMLElement} feed */
  function initQuietFeed(feed) {
    const track = /** @type {HTMLElement | null} */ (feed.querySelector(".feed__track"));
    const rows = /** @type {HTMLElement | null} */ (feed.querySelector(".feed__batch"));
    if (!track || !rows) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");

    const scheduleHide = (min = 1050, max = 2700) => {
      if (motion.matches || document.hidden) return;
      quietFeedTimer = window.setTimeout(hideRandomRow, quietFeedBetween(min, max));
    };

    function hideRandomRow() {
      if (motion.matches || document.hidden || quietFeedActive) return;
      const idx = Math.floor(quietFeedBetween(2, 4));
      quietFeedActive = /** @type {HTMLElement | null} */ (rows?.children[idx] || null);
      if (quietFeedActive) quietFeedActive.classList.add("is-hiding");
    }

    track.addEventListener("animationiteration", (event) => {
      if (event.target === track && event.animationName === "feed-scroll-row") {
        const first = rows.firstElementChild;
        if (first) rows.append(first);
      }
    });
    rows.addEventListener("animationend", (event) => {
      if (event.target !== quietFeedActive || event.animationName !== "feed-close-gap") return;
      if (quietFeedActive) {
        rows.append(quietFeedActive);
        quietFeedActive.classList.remove("is-hiding");
        quietFeedActive = null;
      }
      scheduleHide();
    });
    scheduleHide(480, 1250);
  }

  // Step 1 is gated on the user actually trying a thumb. Later steps don't
  // need interaction so Next is always visible.
  function updateNextGate() {
    const nextBtn = $("tourNextBtn");
    if (tourIndex === 0) {
      const rated = $("demoCard").dataset.state !== "pending";
      nextBtn.hidden = !rated;
    } else {
      nextBtn.hidden = false;
    }
  }

  /** @param {"yes" | "no" | null} decision */
  function paintDemo(decision) {
    const card = $("demoCard");
    const yesBtn = $("demoYes");
    const noBtn = $("demoNo");
    const stateText = $("demoStateText");
    const stateIcon = $("demoStateIcon");

    const state = decision || "pending";
    card.dataset.state = state;
    yesBtn.classList.toggle("is-active", decision === "yes");
    noBtn.classList.toggle("is-active", decision === "no");

    if (decision === "yes") {
      stateText.textContent = "More like this";
      stateIcon.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
      stateIcon.setAttribute("stroke-width", "3");
    } else if (decision === "no") {
      stateText.textContent = "Less like this";
      stateIcon.innerHTML =
        '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
      stateIcon.setAttribute("stroke-width", "3");
    }
    updateNextGate();
  }

  function wireDemo() {
    const yesBtn = $("demoYes");
    const noBtn = $("demoNo");
    const removeBtn = $("demoRemove");

    yesBtn.addEventListener("click", () => {
      const curr = $("demoCard").dataset.state;
      paintDemo(curr === "yes" ? null : "yes");
    });
    noBtn.addEventListener("click", () => {
      const curr = $("demoCard").dataset.state;
      paintDemo(curr === "no" ? null : "no");
    });
    removeBtn.addEventListener("click", () => paintDemo(null));
  }

  async function refreshUI() {
    const store = await chrome.storage.local.get([USER_KEY, ONBOARDED_KEY]);
    const user = /** @type {BonsaiUser | undefined} */ (store[USER_KEY]);
    const signedIn = Boolean(user && user.email);
    const onboarded = Boolean(store[ONBOARDED_KEY]);

    if (signedIn && onboarded) {
      // Already fully set up — jump straight to X. Guards against reopening
      // the onboarding tab after setup.
      await chrome.tabs.update({ url: "https://x.com/home" }).catch(() => {});
      return;
    }

    if (!signedIn) {
      showSection("signedOut");
      return;
    }

    tourIndex = 0;
    renderTour();
    showSection("tour");
  }

  /**
   * Open Google's OAuth consent URL in a new tab. The service worker
   * intercepts the chromiumapp.org redirect, stores the user, and closes
   * the auth tab. We detect completion via chrome.storage.onChanged.
   */
  async function signIn() {
    const btn = /** @type {HTMLButtonElement} */ ($("signInBtn"));
    btn.disabled = true;
    $("signInHint").hidden = false;
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
    } catch (e) {
      const msg = /** @type {Error} */ (e)?.message || String(e);
      alert("Could not start sign-in: " + msg);
      btn.disabled = false;
      $("signInHint").hidden = true;
    }
  }

  async function finishAndOpenX() {
    await chrome.storage.local.set({ [ONBOARDED_KEY]: true });
    await chrome.tabs.update({ url: "https://x.com/home" }).catch(async () => {
      await chrome.tabs.create({ url: "https://x.com/home" });
    });
  }

  function tourNext() {
    if (tourIndex < TOUR_STEPS.length - 1) {
      tourIndex += 1;
      renderTour();
    } else {
      finishAndOpenX();
    }
  }

  function tourBack() {
    if (tourIndex > 0) {
      tourIndex -= 1;
      renderTour();
    }
  }

  // Detect sign-in landing while this tab is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[USER_KEY]) refreshUI();
  });

  document.addEventListener("DOMContentLoaded", () => {
    const manifest = chrome.runtime.getManifest();
    $("verLabel").textContent = "v" + manifest.version;

    $("signInBtn").addEventListener("click", signIn);
    $("tourNextBtn").addEventListener("click", tourNext);
    $("tourBackBtn").addEventListener("click", tourBack);
    wireDemo();

    refreshUI();
  });
})();
