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
   * Launch the OAuth consent flow from the POPUP, not the service worker.
   * MV3 service workers can be evicted between calling launchWebAuthFlow and
   * Google's redirect arriving, which orphans the callback and leaves the
   * browser trying to navigate to the chromiumapp.org URL as a real site
   * (DNS_PROBE_FINISHED_NXDOMAIN). The popup is a short-lived page but it
   * stays open for the full duration of launchWebAuthFlow, and the user
   * gesture context from the click is preserved — Chrome's identity API
   * then reliably intercepts the redirect.
   */
  async function launchWebFlowFromPopup() {
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

    const redirectResponse = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
    if (!redirectResponse) {
      throw new Error("launchWebAuthFlow returned no URL");
    }
    const hash = redirectResponse.split("#")[1] || "";
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    if (!token) {
      const err = params.get("error") || "missing access_token in redirect";
      throw new Error(err);
    }
    return token;
  }

  async function signIn() {
    const btn = /** @type {HTMLButtonElement} */ ($("signInBtn"));
    btn.disabled = true;
    try {
      const token = await launchWebFlowFromPopup();
      const resp = await chrome.runtime.sendMessage({
        type: "bonsai:completeSignIn",
        token,
      });
      if (!resp || resp.error) {
        throw new Error(resp?.error || "completeSignIn returned no user");
      }
    } catch (e) {
      const msg = /** @type {Error} */ (e)?.message || String(e);
      const looksLikeConfig =
        /redirect_uri|invalid_client|Authorization page|invalid request|turned off browser signin|bad client id|OAuth2|access blocked/i.test(
          msg,
        );
      let hint = "";
      if (looksLikeConfig) {
        const redirectUri = chrome.identity.getRedirectURL();
        const extId = chrome.runtime.id;
        hint =
          `\n\nExtension id:  ${extId}` +
          `\nRedirect URI:  ${redirectUri}` +
          `\n\nIn Google Cloud Console (project bonsai-feed-filter), the OAuth client's Authorized redirect URI must equal:\n${redirectUri}` +
          `\n\nFull walkthrough: OAUTH-SETUP.md.`;
      }
      alert("Sign-in failed: " + msg + hint);
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
    $("headerSignOutBtn").addEventListener("click", signOut);
    $("openXBtn").addEventListener("click", openX);
    $("tourNextBtn").addEventListener("click", tourNext);
    $("tourBackBtn").addEventListener("click", tourBack);

    refreshUI();
  });
})();
