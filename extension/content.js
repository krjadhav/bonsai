// Bonsai content script — runs on x.com / twitter.com
// Responsibilities:
//  1. Walk the timeline and attach Yes/No controls to every visible tweet (article).
//  2. Capture tweet contents (text + author + media presence) into chrome.storage.local.
//  3. Show a hovering progress badge that reflects how many posts the user has rated.
//  4. Keep up with the virtualized timeline via MutationObserver + IntersectionObserver.

(() => {
  if (window.__bonsaiInjected) return;
  window.__bonsaiInjected = true;

  const PROCESSED = "bonsaiProcessed";
  const STORAGE_KEY = "bonsaiCaptures";
  const MAX_LOCAL = 500; // cap the local queue so we don't bloat storage

  // --------------------------------------------------------------------------
  // Progress badge — hovering indicator in the bottom-right of the viewport
  // --------------------------------------------------------------------------
  function mountBadge() {
    if (document.getElementById("bonsai-badge")) return;
    const el = document.createElement("div");
    el.id = "bonsai-badge";
    el.innerHTML = `
      <div class="bonsai-badge__row">
        <div class="bonsai-badge__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <circle cx="12" cy="9" r="5" fill="#4ea76d"/>
            <circle cx="7" cy="11" r="3.5" fill="#5bbd7e"/>
            <circle cx="17" cy="11" r="3.5" fill="#3f8f5a"/>
            <rect x="11" y="12" width="2" height="7" rx="1" fill="#5b3a1e"/>
          </svg>
        </div>
        <div class="bonsai-badge__text">
          <div class="bonsai-badge__title">Bonsai</div>
          <div class="bonsai-badge__sub" id="bonsai-badge-sub">0 rated · growing</div>
        </div>
      </div>
      <div class="bonsai-badge__bar">
        <div class="bonsai-badge__fill" id="bonsai-badge-fill"></div>
      </div>
    `;
    document.documentElement.appendChild(el);
  }

  async function updateBadge() {
    const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const rated = captures.filter((c) => c.decision === "yes" || c.decision === "no").length;
    const seen = captures.length;
    const confidence = Math.min(100, Math.round((rated / 50) * 100));
    const fill = document.getElementById("bonsai-badge-fill");
    const sub = document.getElementById("bonsai-badge-sub");
    if (fill) fill.style.width = confidence + "%";
    if (sub) sub.textContent = `${rated} rated · ${seen} seen`;
  }

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
  // Save / update capture in chrome.storage.local (dedup on postId)
  // --------------------------------------------------------------------------
  async function saveCapture(payload) {
    if (!payload.postId) return;
    const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const idx = captures.findIndex((c) => c.postId === payload.postId);
    if (idx === -1) {
      captures.unshift(payload);
    } else {
      // keep earliest capture metadata but refresh decision if provided
      const prev = captures[idx];
      captures[idx] = {
        ...prev,
        ...payload,
        decision: payload.decision ?? prev.decision,
        capturedAt: prev.capturedAt,
      };
    }
    if (captures.length > MAX_LOCAL) captures.length = MAX_LOCAL;
    await chrome.storage.local.set({ [STORAGE_KEY]: captures });
    updateBadge();

    // Fire-and-forget send to backend (background decides whether to actually POST).
    chrome.runtime.sendMessage({ type: "bonsai:capture", payload }).catch(() => {});
  }

  async function setDecision(postId, decision) {
    const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const idx = captures.findIndex((c) => c.postId === postId);
    if (idx === -1) return;
    captures[idx].decision = decision;
    captures[idx].decidedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEY]: captures });
    updateBadge();
    chrome.runtime.sendMessage({
      type: "bonsai:decision",
      payload: captures[idx],
    }).catch(() => {});
  }

  // --------------------------------------------------------------------------
  // Inject Yes/No pills onto each tweet
  // --------------------------------------------------------------------------
  function attachControls(article) {
    if (article.dataset[PROCESSED]) return;
    article.dataset[PROCESSED] = "1";

    const payload = extractTweet(article);
    if (!payload.postId) {
      // Can't rate without an id — skip but allow retry if DOM swaps in.
      delete article.dataset[PROCESSED];
      return;
    }
    saveCapture(payload);

    const bar = document.createElement("div");
    bar.className = "bonsai-bar";
    bar.innerHTML = `
      <button class="bonsai-btn bonsai-btn--yes" type="button" aria-label="More like this">
        <span class="bonsai-btn__dot"></span> Yes
      </button>
      <button class="bonsai-btn bonsai-btn--no" type="button" aria-label="Less like this">
        <span class="bonsai-btn__dot"></span> No
      </button>
      <span class="bonsai-state" data-state="pending">Rate to teach Bonsai</span>
    `;
    bar.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".bonsai-btn");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const decision = btn.classList.contains("bonsai-btn--yes") ? "yes" : "no";
      bar.querySelector(".bonsai-state").dataset.state = decision;
      bar.querySelector(".bonsai-state").textContent =
        decision === "yes" ? "Saved — more like this" : "Saved — less like this";
      bar.classList.remove("bonsai-bar--yes", "bonsai-bar--no");
      bar.classList.add(`bonsai-bar--${decision}`);
      setDecision(payload.postId, decision);
    });

    // Place controls directly inside the article, before the native action row.
    // If we can't find a good anchor, append to the article so they still show.
    const actionBar = article.querySelector('[role="group"]');
    if (actionBar && actionBar.parentElement) {
      actionBar.parentElement.insertBefore(bar, actionBar);
    } else {
      article.appendChild(bar);
    }
  }

  // --------------------------------------------------------------------------
  // Observer wiring — X virtualizes the timeline aggressively.
  // --------------------------------------------------------------------------
  function scan(root = document) {
    const articles = root.querySelectorAll('article[role="article"]');
    articles.forEach(attachControls);
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
    mountBadge();
    updateBadge();
    scan();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Keep badge in sync when sidebar / background mutate storage elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) updateBadge();
  });
})();
