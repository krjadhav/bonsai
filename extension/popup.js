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
  const FILTERS_KEY = "bonsaiFilters";
  /** @type {BonsaiFilters} */
  const DEFAULT_FILTERS = { hideAds: true, mutedWords: [] };

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
    await refreshFilters();
    showSection("home");
  }

  /** @returns {Promise<BonsaiFilters>} */
  async function loadFilters() {
    const { [FILTERS_KEY]: raw } = await chrome.storage.local.get(FILTERS_KEY);
    const stored = /** @type {Partial<BonsaiFilters> | undefined} */ (raw);
    return {
      hideAds: typeof stored?.hideAds === "boolean" ? stored.hideAds : DEFAULT_FILTERS.hideAds,
      mutedWords: Array.isArray(stored?.mutedWords)
        ? stored.mutedWords.filter((w) => typeof w === "string" && w.trim().length > 0)
        : [...DEFAULT_FILTERS.mutedWords],
    };
  }

  /** @param {BonsaiFilters} filters */
  async function saveFilters(filters) {
    await chrome.storage.local.set({ [FILTERS_KEY]: filters });
  }

  async function refreshFilters() {
    const filters = await loadFilters();
    /** @type {HTMLInputElement} */ ($("hideAdsToggle")).checked = filters.hideAds;
    paintChips(filters.mutedWords);
  }

  /** @param {string[]} words */
  function paintChips(words) {
    const host = $("mutedChips");
    host.innerHTML = "";
    for (const word of words) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.setAttribute("role", "listitem");
      const label = document.createElement("span");
      label.className = "chip__label";
      label.textContent = word;
      const btn = document.createElement("button");
      btn.className = "chip__remove";
      btn.type = "button";
      btn.setAttribute("aria-label", `Remove ${word}`);
      btn.textContent = "×";
      btn.addEventListener("click", () => removeMutedWord(word));
      chip.appendChild(label);
      chip.appendChild(btn);
      host.appendChild(chip);
    }
  }

  /** @param {string} word */
  async function addMutedWord(word) {
    const trimmed = word.trim().toLowerCase();
    if (!trimmed) return;
    const filters = await loadFilters();
    if (filters.mutedWords.includes(trimmed)) return;
    filters.mutedWords.push(trimmed);
    await saveFilters(filters);
    paintChips(filters.mutedWords);
  }

  /** @param {string} word */
  async function removeMutedWord(word) {
    const filters = await loadFilters();
    filters.mutedWords = filters.mutedWords.filter((w) => w !== word);
    await saveFilters(filters);
    paintChips(filters.mutedWords);
  }

  async function onHideAdsChange() {
    const checked = /** @type {HTMLInputElement} */ ($("hideAdsToggle")).checked;
    const filters = await loadFilters();
    filters.hideAds = checked;
    await saveFilters(filters);
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
    $("hideAdsToggle").addEventListener("change", onHideAdsChange);
    const mutedInput = /** @type {HTMLInputElement} */ ($("mutedInput"));
    mutedInput.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== ",") return;
      ev.preventDefault();
      const value = mutedInput.value;
      mutedInput.value = "";
      addMutedWord(value);
    });
    mutedInput.addEventListener("blur", () => {
      if (!mutedInput.value.trim()) return;
      const value = mutedInput.value;
      mutedInput.value = "";
      addMutedWord(value);
    });

    refreshUI();
  });
})();
