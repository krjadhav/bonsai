// Bonsai content script — runs on x.com / twitter.com
//
// Storage policy: only posts the user explicitly rates (Yes/No) land in
// chrome.storage.local. Undecided impressions are tracked in-memory per tab
// for the progress badge only; they never hit storage or the backend. This
// keeps the validation sidebar focused on real teaching signal and keeps
// Firestore writes proportional to interactions, not scrolling.

(() => {
  if (window.__bonsaiInjected) return;
  window.__bonsaiInjected = true;

  const PROCESSED = "bonsaiProcessed";
  const STORAGE_KEY = "bonsaiCaptures";
  const ONBOARDED_KEY = "bonsaiOnboarded";
  const COACH_KEY = "bonsaiCoachSeen";
  const MAX_LOCAL = 500;

  const seenThisSession = new Set();
  let coachEl = null;

  // --------------------------------------------------------------------------
  // Extract tweet payload from an <article> node
  // --------------------------------------------------------------------------
  function extractTweet(article) {
    const permalink = article.querySelector('a[href*="/status/"]');
    const href = permalink?.getAttribute("href") || "";
    const match = href.match(/\/status\/(\d+)/);
    const postId = match ? match[1] : null;

    const textEl = article.querySelector('[data-testid="tweetText"]');
    const content = textEl ? textEl.innerText.trim() : "";

    const userEl = article.querySelector('[data-testid="User-Name"]');
    let authorName = null;
    let authorHandle = null;
    if (userEl) {
      const spans = userEl.querySelectorAll("span");
      for (const s of spans) {
        const t = s.innerText.trim();
        if (!authorName && t && !t.startsWith("@") && !t.includes("·")) authorName = t;
        if (!authorHandle && t.startsWith("@")) authorHandle = t;
      }
    }

    const timeEl = article.querySelector("time");
    const tweetedAt = timeEl ? timeEl.getAttribute("datetime") : null;

    const hasImage = Boolean(article.querySelector('[data-testid="tweetPhoto"]'));
    const hasVideo = Boolean(
      article.querySelector('[data-testid="videoPlayer"], video, [data-testid="previewInterstitial"]'),
    );
    const mediaTypes = [];
    if (hasImage) mediaTypes.push("image");
    if (hasVideo) mediaTypes.push("video");

    return {
      postId,
      permalink: href ? new URL(href, "https://x.com").toString() : null,
      authorName,
      authorHandle,
      content,
      tweetedAt,
      hasMedia: mediaTypes.length > 0,
      mediaTypes,
      capturedAt: new Date().toISOString(),
      decision: null,
    };
  }

  // --------------------------------------------------------------------------
  // Storage mutations — only decided posts live here
  // --------------------------------------------------------------------------
  async function persistDecision(payload, decision) {
    const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const idx = captures.findIndex((c) => c.postId === payload.postId);
    const entry = {
      ...payload,
      decision,
      decidedAt: new Date().toISOString(),
    };
    if (idx === -1) captures.unshift(entry);
    else captures[idx] = { ...captures[idx], ...entry };
    if (captures.length > MAX_LOCAL) captures.length = MAX_LOCAL;
    await chrome.storage.local.set({ [STORAGE_KEY]: captures });
    chrome.runtime.sendMessage({ type: "bonsai:decision", payload: entry }).catch(() => {});
  }

  async function removeDecision(postId) {
    const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const idx = captures.findIndex((c) => c.postId === postId);
    if (idx === -1) return;
    captures.splice(idx, 1);
    await chrome.storage.local.set({ [STORAGE_KEY]: captures });
  }

  // --------------------------------------------------------------------------
  // SVG icons — small, inlined so no asset requests on X
  // --------------------------------------------------------------------------
  const ICON_CHECK =
    '<svg class="bonsai-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICON_X =
    '<svg class="bonsai-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_THUMB_UP =
    '<svg class="bonsai-ico bonsai-ico--thumb" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73V10z"/></svg>';
  const ICON_THUMB_DOWN =
    '<svg class="bonsai-ico bonsai-ico--thumb bonsai-ico--flip" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73V10z"/></svg>';
  const ICON_TRASH =
    '<svg class="bonsai-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

  // --------------------------------------------------------------------------
  // Inject rate controls onto each tweet
  // --------------------------------------------------------------------------
  function attachControls(article) {
    if (article.dataset[PROCESSED]) return;
    article.dataset[PROCESSED] = "1";

    const payload = extractTweet(article);
    if (!payload.postId) {
      delete article.dataset[PROCESSED];
      return;
    }

    seenThisSession.add(payload.postId);

    // Header strip — "Rate to teach Bonsai" + thumbs up/down
    const header = document.createElement("div");
    header.className = "bonsai-header";
    header.dataset.state = "pending";
    header.innerHTML = `
      <span class="bonsai-header__title">Rate to teach Bonsai</span>
      <div class="bonsai-thumbs" role="group" aria-label="Rate this post">
        <button type="button" class="bonsai-thumb bonsai-thumb--yes" aria-label="More like this" title="More like this">
          ${ICON_CHECK}${ICON_THUMB_UP}
        </button>
        <button type="button" class="bonsai-thumb bonsai-thumb--no" aria-label="Less like this" title="Less like this">
          ${ICON_X}${ICON_THUMB_DOWN}
        </button>
      </div>
    `;

    // Footer — status + Remove
    const footer = document.createElement("div");
    footer.className = "bonsai-footer";
    footer.dataset.state = "pending";
    footer.innerHTML = `
      <span class="bonsai-footer__state" data-state="pending">Awaiting your rating</span>
      <button type="button" class="bonsai-footer__remove" aria-label="Remove rating" hidden>
        ${ICON_TRASH}<span>Remove</span>
      </button>
    `;

    const btnYes = header.querySelector(".bonsai-thumb--yes");
    const btnNo = header.querySelector(".bonsai-thumb--no");
    const state = footer.querySelector(".bonsai-footer__state");
    const btnRemove = footer.querySelector(".bonsai-footer__remove");

    function paint(decision) {
      const s = decision || "pending";
      header.dataset.state = s;
      footer.dataset.state = s;
      article.dataset.bonsaiState = s;
      btnYes.classList.toggle("is-active", decision === "yes");
      btnNo.classList.toggle("is-active", decision === "no");
      state.dataset.state = s;
      if (decision === "yes") {
        state.innerHTML = `${ICON_CHECK}<span>More like this</span>`;
      } else if (decision === "no") {
        state.innerHTML = `${ICON_X}<span>Less like this</span>`;
      } else {
        state.textContent = "Awaiting your rating";
      }
      btnRemove.hidden = !decision;
    }

    function handleChoose(ev, decision) {
      ev.preventDefault();
      ev.stopPropagation();
      if (article.dataset.bonsaiState === decision) return;
      paint(decision);
      persistDecision(payload, decision);
    }

    btnYes.addEventListener("click", (e) => {
      handleChoose(e, "yes");
      dismissCoach();
    });
    btnNo.addEventListener("click", (e) => {
      handleChoose(e, "no");
      dismissCoach();
    });
    btnRemove.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      paint(null);
      removeDecision(payload.postId);
    });

    // Place header + footer as SIBLINGS of the article, not children. X styles
    // <article> as a flex row (avatar | content) — injecting into it makes our
    // UI a flex item next to the tweet instead of above/below it. If the
    // article's parent also happens to be a flex row, fall back to the content
    // column inside the article (the parent of the native action [role="group"]).
    const parent = article.parentElement;
    const parentStyle = parent ? getComputedStyle(parent) : null;
    const parentIsRow =
      parentStyle &&
      parentStyle.display.includes("flex") &&
      parentStyle.flexDirection.startsWith("row");

    if (parent && !parentIsRow) {
      parent.insertBefore(header, article);
      if (article.nextSibling) parent.insertBefore(footer, article.nextSibling);
      else parent.appendChild(footer);
    } else {
      const col = article.querySelector('[role="group"]')?.parentElement;
      if (col) {
        col.insertBefore(header, col.firstChild);
        col.appendChild(footer);
      } else {
        // Last resort — append inside article; visually worse but functional.
        article.appendChild(header);
        article.appendChild(footer);
      }
    }

    paint(null);
  }

  // --------------------------------------------------------------------------
  // First-visit coach overlay — a floating card that nudges the user to rate
  // their first post. Only shows for users who finished popup onboarding and
  // haven't dismissed it. Clears itself on first rating or explicit close.
  // --------------------------------------------------------------------------
  async function maybeShowCoach() {
    const { [ONBOARDED_KEY]: onboarded, [COACH_KEY]: seen } =
      await chrome.storage.local.get([ONBOARDED_KEY, COACH_KEY]);
    if (!onboarded || seen) return;
    mountCoach();
  }

  function mountCoach() {
    if (coachEl || document.getElementById("bonsai-coach")) return;
    const el = document.createElement("div");
    el.id = "bonsai-coach";
    el.className = "bonsai-coach";
    el.innerHTML = `
      <button type="button" class="bonsai-coach__close" aria-label="Dismiss">
        <svg class="bonsai-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="bonsai-coach__title">Try it on your first post</div>
      <div class="bonsai-coach__body">
        Tap <b class="bonsai-coach__good">More like this</b> on a post you want more of, or
        <b class="bonsai-coach__bad">Less like this</b> on one you don't. Bonsai learns from both.
      </div>
    `;
    el.querySelector(".bonsai-coach__close").addEventListener("click", dismissCoach);
    document.body.appendChild(el);
    coachEl = el;
  }

  function dismissCoach() {
    if (coachEl) {
      coachEl.remove();
      coachEl = null;
    }
    const existing = document.getElementById("bonsai-coach");
    if (existing) existing.remove();
    chrome.storage.local.set({ [COACH_KEY]: true }).catch(() => {});
  }

  // --------------------------------------------------------------------------
  // Observer wiring — X virtualizes the timeline aggressively
  // --------------------------------------------------------------------------
  function scan(root = document) {
    root.querySelectorAll('article[role="article"]').forEach(attachControls);
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.matches && n.matches('article[role="article"]')) attachControls(n);
        else scan(n);
      });
    }
  });

  function boot() {
    scan();
    observer.observe(document.body, { childList: true, subtree: true });
    maybeShowCoach();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
