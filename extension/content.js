// @ts-check
// Bonsai content script — runs on x.com / twitter.com
//
// Storage policy: only posts the user explicitly rates (Yes/No) land in
// chrome.storage.local. Undecided impressions are tracked in-memory per tab
// for the progress badge only; they never hit storage or the backend. This
// keeps Firestore writes proportional to interactions, not scrolling.

(() => {
  if (window.__bonsaiInjected) return;
  window.__bonsaiInjected = true;

  const PROCESSED = "bonsaiProcessed";
  const STORAGE_KEY = "bonsaiCaptures";
  const ONBOARDED_KEY = "bonsaiOnboarded";
  const COACH_KEY = "bonsaiCoachSeen";
  const MAX_LOCAL = 500;
  // Each tier is PROGRESS_TARGET ratings. The bar always shows progress within
  // the current tier (count mod PROGRESS_TARGET). After the last tier the bar
  // stays full and the tier label pins at Diamond.
  const PROGRESS_TARGET = 50;
  const TIERS = /** @type {const} */ ([
    "Iron",
    "Bronze",
    "Silver",
    "Gold",
    "Platinum",
    "Sapphire",
    "Ruby",
    "Emerald",
    "Diamond",
  ]);
  const MAX_TIER_INDEX = TIERS.length - 1;

  /**
   * @param {number} count
   * @returns {{ name: string, within: number }}
   */
  function tierFor(count) {
    const raw = Math.floor(count / PROGRESS_TARGET);
    const index = Math.min(raw, MAX_TIER_INDEX);
    const within =
      index === MAX_TIER_INDEX ? PROGRESS_TARGET : count - index * PROGRESS_TARGET;
    return { name: TIERS[index], within };
  }

  /** @type {Set<string>} */
  const seenThisSession = new Set();
  /** @type {HTMLElement | null} */
  let coachEl = null;
  /** @type {HTMLElement | null} */
  let progressEl = null;

  // --------------------------------------------------------------------------
  // Extract tweet payload from an <article> node
  // --------------------------------------------------------------------------
  /**
   * @param {HTMLElement} article
   * @returns {BonsaiCapture}
   */
  function extractTweet(article) {
    // Scope outer-tweet reads so a quoted Article's URL / text can't leak
    // into the outer capture. Quoted content is extracted separately in
    // extractRepostContext using the same wrapper.
    const outerScope = outerTweetScope(article);
    const permalink = outerScope.querySelector('a[href*="/status/"]');
    const href = permalink?.getAttribute("href") || "";
    const match = href.match(/\/status\/(\d+)/);
    // X long-form Articles render a card linking to `/i/article/<id>`. When
    // the parent tweet has no /status/ anchor (some article-only surfaces),
    // fall back to the article id so attachControls still injects controls.
    const articleUrl = detectArticleUrl(outerScope);
    const articleIdMatch = articleUrl ? articleUrl.match(/\/i\/article\/(\d+)/) : null;
    const postId = match ? match[1] : articleIdMatch ? `article_${articleIdMatch[1]}` : null;

    const textEl = /** @type {HTMLElement | null} */ (
      outerScope.querySelector('[data-testid="tweetText"]')
    );
    let content = textEl ? textEl.innerText.trim() : "";
    // Article cards don't carry their body in tweetText — fold the headline
    // and viewer URL into content so the capture carries a pointer to the
    // source without needing a separate schema field.
    if (articleUrl) {
      const headline = readArticleHeadline(outerScope);
      const parts = [content, headline, articleUrl].filter(Boolean);
      content = parts.join("\n");
    }

    const userEl = outerScope.querySelector('[data-testid="User-Name"]');
    /** @type {string | null} */
    let authorName = null;
    /** @type {string | null} */
    let authorHandle = null;
    if (userEl) {
      const { name, handle } = readUserBlock(userEl);
      authorName = name;
      authorHandle = handle;
    }

    const timeEl = outerScope.querySelector("time");
    const tweetedAt = timeEl ? timeEl.getAttribute("datetime") : null;

    const mediaTypes = detectMedia(outerScope);
    const thumbnailUrl = detectThumbnail(outerScope);
    const { repostedBy, quoted } = extractRepostContext(article);

    return {
      postId,
      permalink: href
        ? new URL(href, "https://x.com").toString()
        : articleUrl || null,
      authorName,
      authorHandle,
      content,
      tweetedAt,
      hasMedia: mediaTypes.length > 0,
      mediaTypes,
      repostedBy,
      quoted,
      thumbnailUrl,
      capturedAt: new Date().toISOString(),
      decision: null,
    };
  }

  // Return a DOM subtree that holds the OUTER tweet only, excluding any
  // nested quoted-tweet card. X wraps the embedded quoted tweet in a
  // `div[role="link"]`; cloning the article and removing those wrappers
  // lets us run normal selectors (tweetText, card.wrapper, etc.) against
  // just the outer tweet without them picking up the inner ones.
  /**
   * @param {HTMLElement} article
   * @returns {HTMLElement}
   */
  function outerTweetScope(article) {
    const quoteWrapper = findQuoteWrapper(article);
    if (!quoteWrapper) return article;
    const clone = /** @type {HTMLElement} */ (article.cloneNode(true));
    // Find the same wrapper inside the clone by walking the index path so
    // we can strip it. querySelectorAll('[role="link"]') then nth-of-match
    // is cheap and robust enough for the small subtrees X renders here.
    const originals = Array.from(article.querySelectorAll('[role="link"]'));
    const idx = originals.indexOf(quoteWrapper);
    const clones = Array.from(clone.querySelectorAll('[role="link"]'));
    if (idx >= 0 && clones[idx]) clones[idx].remove();
    return clone;
  }

  // Locate the DOM subtree that wraps the quoted tweet, if any. X renders
  // the quoted card as a `div[role="link"][tabindex="0"]` with the nested
  // User-Name inside — we anchor off the second User-Name so we tolerate
  // DOM shuffles around card.wrapper / card.layoutLarge that happen when X
  // ships minor UI updates.
  /**
   * @param {HTMLElement} article
   * @returns {HTMLElement | null}
   */
  function findQuoteWrapper(article) {
    const userNames = article.querySelectorAll('[data-testid="User-Name"]');
    if (userNames.length < 2) return null;
    const second = /** @type {HTMLElement} */ (userNames[1]);
    const wrapper = second.closest('div[role="link"]');
    return /** @type {HTMLElement | null} */ (wrapper);
  }

  // X long-form Article links point at `/i/article/<id>`. Return the first one
  // inside this article as an absolute URL, or null when none is present.
  /**
   * @param {HTMLElement} article
   * @returns {string | null}
   */
  function detectArticleUrl(article) {
    const link = /** @type {HTMLAnchorElement | null} */ (
      article.querySelector('a[href*="/i/article/"]')
    );
    const raw = link?.getAttribute("href");
    if (!raw) return null;
    return new URL(raw, "https://x.com").toString();
  }

  // Article cards expose their title in a heading inside the card wrapper. Fall
  // back to any heading if the card testid isn't present.
  /**
   * @param {HTMLElement} article
   * @returns {string | null}
   */
  function readArticleHeadline(article) {
    const el = /** @type {HTMLElement | null} */ (
      article.querySelector(
        '[data-testid="card.wrapper"] [role="heading"], [data-testid="card.wrapper"] h2, [role="heading"][aria-level="1"], [role="heading"][aria-level="2"]',
      )
    );
    const txt = el ? el.innerText.trim() : "";
    return txt || null;
  }

  // Pull a display name + handle out of a [data-testid="User-Name"] subtree.
  /**
   * @param {Element} userEl
   * @returns {{ name: string | null, handle: string | null }}
   */
  function readUserBlock(userEl) {
    let name = null;
    let handle = null;
    for (const s of userEl.querySelectorAll("span")) {
      const t = /** @type {HTMLElement} */ (s).innerText.trim();
      if (!name && t && !t.startsWith("@") && !t.includes("·")) name = t;
      if (!handle && t.startsWith("@")) handle = t;
    }
    return { name, handle };
  }

  // Two repost shapes to distinguish:
  //   1. Plain retweet: X shows the original tweet with a `socialContext`
  //      chip above it ("Jane reposted"). The article's authorName is still
  //      the original author — we just surface who reposted.
  //   2. Quote tweet: the article has two User-Name + two tweetText nodes.
  //      Outer author = the quoter; nested = who/what they quoted.
  //   Both can co-occur (a retweet of a quote tweet).
  /**
   * @param {HTMLElement} article
   * @returns {{ repostedBy: string | null, quoted: BonsaiQuotedPost | null }}
   */
  function extractRepostContext(article) {
    const socialCtx = /** @type {HTMLElement | null} */ (
      article.querySelector('[data-testid="socialContext"]')
    );
    let repostedBy = null;
    if (socialCtx) {
      const txt = socialCtx.innerText.trim();
      if (/reposted/i.test(txt)) {
        repostedBy = txt.replace(/\s*reposted.*$/i, "").trim() || null;
      }
    }
    /** @type {BonsaiQuotedPost | null} */
    let quoted = null;
    const quoteWrapper = findQuoteWrapper(article);
    if (quoteWrapper) {
      const userBlock = quoteWrapper.querySelector('[data-testid="User-Name"]');
      const { name, handle } = userBlock
        ? readUserBlock(userBlock)
        : { name: null, handle: null };
      // Scope text extraction to the quote wrapper so the outer tweet's
      // text can't leak in, and so image-only / article-style quoted posts
      // still yield something useful via the heading / card URL fallback.
      const qTextEl = /** @type {HTMLElement | null} */ (
        quoteWrapper.querySelector('[data-testid="tweetText"]')
      );
      let content = qTextEl ? qTextEl.innerText.trim() : "";
      const qArticleUrl = detectArticleUrl(quoteWrapper);
      if (qArticleUrl) {
        const headline = readArticleHeadline(quoteWrapper);
        const parts = [content, headline, qArticleUrl].filter(Boolean);
        content = parts.join("\n");
      }
      quoted = { authorName: name, authorHandle: handle, content };
    }
    return { repostedBy, quoted };
  }

  // Media detection is called twice: once at article attach time, and again at
  // rating time. X lazy-loads the <video> player — at attach time only the
  // poster <img> is mounted (which matches tweetPhoto), so an early read tags
  // a video post as an image. Re-reading at click time catches the final DOM.
  // Video is preferred when both poster and player are present.
  /**
   * @param {HTMLElement} article
   * @returns {string[]}
   */
  function detectMedia(article) {
    const hasVideo = Boolean(
      article.querySelector(
        [
          '[data-testid="videoPlayer"]',
          '[data-testid="videoComponent"]',
          '[data-testid="previewInterstitial"]',
          'video',
          'div[aria-label="Embedded video"]',
        ].join(","),
      ),
    );
    if (hasVideo) return ["video"];
    const hasImage = Boolean(
      article.querySelector('[data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media"]'),
    );
    return hasImage ? ["image"] : [];
  }

  // Grab a preview image URL for the article's media. For videos X exposes it
  // as the <video poster="…"> attr once the player hydrates; before that only
  // a nested <img> inside the videoComponent carries it. For plain image posts
  // the first tweetPhoto <img> is the preview. Returns null when nothing is
  // mounted yet — caller re-reads at click time for the same lazy-hydration
  // reason detectMedia already handles.
  /**
   * @param {HTMLElement} article
   * @returns {string | null}
   */
  function detectThumbnail(article) {
    const video = /** @type {HTMLVideoElement | null} */ (article.querySelector("video"));
    const posterAttr = video?.getAttribute("poster") || "";
    if (posterAttr) return posterAttr;
    const videoImg = /** @type {HTMLImageElement | null} */ (
      article.querySelector('[data-testid="videoComponent"] img, [data-testid="previewInterstitial"] img')
    );
    if (videoImg?.src) return videoImg.src;
    const photoImg = /** @type {HTMLImageElement | null} */ (
      article.querySelector('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]')
    );
    if (photoImg?.src) return photoImg.src;
    return null;
  }

  // --------------------------------------------------------------------------
  // Storage mutations — only decided posts live here
  // --------------------------------------------------------------------------
  /**
   * @param {BonsaiCapture} payload
   * @param {"yes" | "no"} decision
   */
  async function persistDecision(payload, decision) {
    const store = await chrome.storage.local.get(STORAGE_KEY);
    const captures = /** @type {BonsaiCapture[]} */ (store[STORAGE_KEY] || []);
    const idx = captures.findIndex((c) => c.postId === payload.postId);
    /** @type {BonsaiCapture} */
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

  /** @param {string | null} postId */
  async function removeDecision(postId) {
    const store = await chrome.storage.local.get(STORAGE_KEY);
    const captures = /** @type {BonsaiCapture[]} */ (store[STORAGE_KEY] || []);
    const idx = captures.findIndex((c) => c.postId === postId);
    if (idx !== -1) {
      captures.splice(idx, 1);
      await chrome.storage.local.set({ [STORAGE_KEY]: captures });
    }
    // Even if the capture isn't in local storage (e.g. a device that never
    // saw this row until the last hydrate), tell background to DELETE it in
    // Firestore. background.js enqueues a tombstone so hydrate won't
    // resurrect the row before the delete lands.
    if (postId) {
      chrome.runtime
        .sendMessage({ type: "bonsai:removeDecision", postId })
        .catch(() => {});
    }
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
  /** @param {HTMLElement} article */
  function attachControls(article) {
    if (article.dataset[PROCESSED]) return;
    article.dataset[PROCESSED] = "1";

    const payload = extractTweet(article);
    if (!payload.postId) {
      delete article.dataset[PROCESSED];
      return;
    }

    seenThisSession.add(payload.postId);

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

    const footer = document.createElement("div");
    footer.className = "bonsai-footer";
    footer.dataset.state = "pending";
    footer.innerHTML = `
      <span class="bonsai-footer__state" data-state="pending">Awaiting your rating</span>
      <button type="button" class="bonsai-footer__remove" aria-label="Remove rating" hidden>
        ${ICON_TRASH}<span>Remove</span>
      </button>
    `;

    const btnYes = /** @type {HTMLButtonElement} */ (header.querySelector(".bonsai-thumb--yes"));
    const btnNo = /** @type {HTMLButtonElement} */ (header.querySelector(".bonsai-thumb--no"));
    const state = /** @type {HTMLElement} */ (footer.querySelector(".bonsai-footer__state"));
    const btnRemove = /** @type {HTMLButtonElement} */ (
      footer.querySelector(".bonsai-footer__remove")
    );

    /** @param {"yes" | "no" | null} decision */
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

    /**
     * @param {Event} ev
     * @param {"yes" | "no"} decision
     */
    function handleChoose(ev, decision) {
      ev.preventDefault();
      ev.stopPropagation();
      if (article.dataset.bonsaiState === decision) return;
      paint(decision);
      // Re-detect media: X lazy-loads the video player after attach, so the
      // original payload can miss video entirely or mislabel it as image.
      // Same hydration race applies to the poster — re-read the thumbnail too
      // so videos captured at click time get the pbs.twimg.com URL instead of
      // the null that extractTweet saw at attach.
      const freshScope = outerTweetScope(article);
      const freshTypes = detectMedia(freshScope);
      payload.mediaTypes = freshTypes;
      payload.hasMedia = freshTypes.length > 0;
      const freshThumb = detectThumbnail(freshScope);
      if (freshThumb) payload.thumbnailUrl = freshThumb;
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
    const closeBtn = /** @type {HTMLButtonElement | null} */ (
      el.querySelector(".bonsai-coach__close")
    );
    closeBtn?.addEventListener("click", dismissCoach);
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
  // Progress hover-bar — shows rated-yes and rated-no counts toward the
  // PROGRESS_TARGET milestone so the user knows how much teaching signal is
  // left before Bonsai has enough to learn from. Hidden once both sides are
  // satisfied; nothing to nag the user about after that.
  // --------------------------------------------------------------------------
  function mountProgress() {
    if (progressEl || document.getElementById("bonsai-progress")) return;
    const el = document.createElement("div");
    el.id = "bonsai-progress";
    el.className = "bonsai-progress";
    el.innerHTML = `
      <div class="bonsai-progress__title">Teaching Bonsai</div>
      <div class="bonsai-progress__row" data-kind="yes">
        <span class="bonsai-progress__label">
          <svg class="bonsai-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73V10z"/></svg>
          <span>More like this</span>
          <span class="bonsai-progress__tier" id="bonsai-progress-yes-tier">${TIERS[0]}</span>
        </span>
        <span class="bonsai-progress__count" id="bonsai-progress-yes-count">0 / ${PROGRESS_TARGET}</span>
        <div class="bonsai-progress__bar"><div class="bonsai-progress__fill" id="bonsai-progress-yes-fill"></div></div>
      </div>
      <div class="bonsai-progress__row" data-kind="no">
        <span class="bonsai-progress__label">
          <svg class="bonsai-ico bonsai-ico--flip" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73V10z"/></svg>
          <span>Less like this</span>
          <span class="bonsai-progress__tier" id="bonsai-progress-no-tier">${TIERS[0]}</span>
        </span>
        <span class="bonsai-progress__count" id="bonsai-progress-no-count">0 / ${PROGRESS_TARGET}</span>
        <div class="bonsai-progress__bar"><div class="bonsai-progress__fill" id="bonsai-progress-no-fill"></div></div>
      </div>
      <div class="bonsai-progress__done" id="bonsai-progress-done" hidden>
        Diamond tier reached on both sides. Bonsai is fully trained.
      </div>
    `;
    document.body.appendChild(el);
    progressEl = el;
  }

  /** @param {BonsaiCapture[]} captures */
  function paintProgress(captures) {
    if (!progressEl) return;
    let yes = 0;
    let no = 0;
    for (const c of captures) {
      if (c.decision === "yes") yes++;
      else if (c.decision === "no") no++;
    }
    const yesTier = tierFor(yes);
    const noTier = tierFor(no);
    const yesPct = (yesTier.within / PROGRESS_TARGET) * 100;
    const noPct = (noTier.within / PROGRESS_TARGET) * 100;

    const yesCount = document.getElementById("bonsai-progress-yes-count");
    const noCount = document.getElementById("bonsai-progress-no-count");
    const yesFill = document.getElementById("bonsai-progress-yes-fill");
    const noFill = document.getElementById("bonsai-progress-no-fill");
    const yesTierEl = document.getElementById("bonsai-progress-yes-tier");
    const noTierEl = document.getElementById("bonsai-progress-no-tier");
    const done = document.getElementById("bonsai-progress-done");
    if (yesCount) yesCount.textContent = `${yesTier.within} / ${PROGRESS_TARGET}`;
    if (noCount) noCount.textContent = `${noTier.within} / ${PROGRESS_TARGET}`;
    if (yesFill) yesFill.style.width = yesPct + "%";
    if (noFill) noFill.style.width = noPct + "%";
    if (yesTierEl) yesTierEl.textContent = yesTier.name;
    if (noTierEl) noTierEl.textContent = noTier.name;

    const cap = TIERS.length * PROGRESS_TARGET;
    const complete = yes >= cap && no >= cap;
    progressEl.classList.toggle("is-complete", complete);
    if (done) done.hidden = !complete;
  }

  async function refreshProgress() {
    const { [STORAGE_KEY]: raw } = await chrome.storage.local.get(STORAGE_KEY);
    const captures = /** @type {BonsaiCapture[]} */ (raw || []);
    paintProgress(captures);
  }

  // --------------------------------------------------------------------------
  // Observer wiring — X virtualizes the timeline aggressively
  // --------------------------------------------------------------------------
  /** @param {Document | HTMLElement} root */
  function scan(root) {
    root.querySelectorAll('article[role="article"]').forEach((a) =>
      attachControls(/** @type {HTMLElement} */ (a)),
    );
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const el = /** @type {HTMLElement} */ (n);
        if (typeof el.matches === "function" && el.matches('article[role="article"]')) {
          attachControls(el);
        } else {
          scan(el);
        }
      });
    }
  });

  function boot() {
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
    mountProgress();
    refreshProgress();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) {
        const next = /** @type {BonsaiCapture[] | undefined} */ (
          changes[STORAGE_KEY].newValue
        );
        paintProgress(next || []);
      }
    });
    maybeShowCoach();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
