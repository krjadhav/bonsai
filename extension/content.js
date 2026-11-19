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
  const FILTERS_KEY = "bonsaiFilters";
  // Debounce window for batched hide/show classification. The DOM observer
  // fires attachControls many times per scroll — holding them briefly lets us
  // ship one `bonsai:filter` request per burst instead of one per article.
  const FILTER_DEBOUNCE_MS = 250;
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
  /** @type {MutationObserver | null} */
  let domObserver = null;

  // Per-postId record of every article we've attached controls to in this tab.
  // Lets us apply hide/show decisions coming back from the filter endpoint
  // without re-querying the DOM, and re-sweep the whole set when filter prefs
  // change in the popup.
  /**
   * @typedef {Object} TrackedArticle
   * @property {HTMLElement} article
   * @property {HTMLElement} header
   * @property {HTMLElement} footer
   * @property {BonsaiCapture} payload
   * @property {HTMLElement | null} hiddenBar
   * @property {HTMLElement | null} aiTag
   */
  /** @type {Map<string, TrackedArticle>} */
  const tracked = new Map();

  // Pending ids waiting for the next debounced filter flush.
  /** @type {Set<string>} */
  const filterQueue = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let filterTimer = null;

  // Experimental AI-detector state. `aiEnabled` mirrors
  // `bonsaiConfig.experimentalAiDetector`; false short-circuits every detector
  // call. Results are cached per-tab so scrolling back doesn't re-classify.
  // The debounce window is deliberately slow (600ms) because inference is
  // ~300-700ms per tweet and we want to batch.
  let aiEnabled = false;
  const DETECT_DEBOUNCE_MS = 600;
  const DETECT_BATCH = 16;
  /** @type {Map<string, BonsaiDetectorResult>} */
  const detectCache = new Map();
  /** @type {Set<string>} */
  const detectQueue = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let detectTimer = null;

  // When the extension is reloaded or updated, every already-injected content
  // script has its `chrome` object detached — `chrome.storage` becomes
  // undefined and every subsequent call throws "Cannot read properties of
  // undefined (reading 'local')" from async callbacks the user can't see.
  // Guard every chrome.* call, and tear down the MutationObserver on the
  // first detected invalidation so we stop spamming errors as the SPA keeps
  // mutating the feed.
  function isExtAlive() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  function teardownOnInvalidation() {
    if (domObserver) {
      try {
        domObserver.disconnect();
      } catch {
        // ignore
      }
      domObserver = null;
    }
  }

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
    const href = pickCleanStatusHref(outerScope);
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
      const card = readArticleCard(outerScope);
      const headline = card.title || readArticleHeadline(outerScope);
      const summary =
        headline && card.preview ? `${headline}: ${card.preview}` : headline;
      const parts = [content, summary, articleUrl].filter(Boolean);
      content = parts.join("\n");
    }
    // Full-view Article page: fold title + Draft.js body into content so the
    // capture carries the actual article rather than just the permalink.
    const readView = readArticleReadView(outerScope);
    if (readView.title || readView.body) {
      const summary =
        readView.title && readView.body
          ? `${readView.title}\n\n${readView.body}`
          : readView.title || readView.body;
      content = content ? `${content}\n${summary}` : /** @type {string} */ (summary);
    }
    // When the outer tweet is an X Article (long-form) or otherwise has no
    // inline text, fall back to the status permalink so the capture still
    // carries a pointer to the source the user can open.
    if (!content && href) {
      content = new URL(href, "https://x.com").toString();
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
    const flags = detectAdFlags(article);

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
      isPromoted: flags.promoted,
      isMadeWithAi: flags.madeWithAi,
      capturedAt: new Date().toISOString(),
      decision: null,
    };
  }

  // X labels promoted posts in several shapes — none consistent across the
  // product, hence the multi-signal approach. Also returns a separate flag
  // for the "Made with AI" chip X adds to AI-generated posts.
  //
  // Promoted signals (any match):
  //   1. `[data-testid="socialContext"]` starting with "Ad" / "Promoted"
  //      (seen on quoted / retweet-style ads).
  //   2. An outbound link carrying X's `twclid=` tracking param — present
  //      on every promoted-card link, missing on organic quoted URLs.
  //   3. `[data-testid="card-website-cta-bar"]` — only promoted cards show
  //      this Sign-up / Learn-more pill.
  //   4. A short `<span>Ad</span>` label outside tweetText / quoted scope.
  //      Scoped lookup keeps "pl**ad**" / "r**ead**" from false-positiving.
  //
  // Made-with-AI signal: a `<span>Made with AI</span>` outside tweetText.
  //
  /**
   * @param {HTMLElement} article
   * @returns {{ promoted: boolean, madeWithAi: boolean }}
   */
  function detectAdFlags(article) {
    let promoted = false;
    let madeWithAi = false;

    const ctx = /** @type {HTMLElement | null} */ (
      article.querySelector('[data-testid="socialContext"]')
    );
    if (ctx && /^(ad|promoted)\b/i.test((ctx.innerText || "").trim())) {
      promoted = true;
    }
    if (!promoted && article.querySelector('a[href*="twclid="]')) {
      promoted = true;
    }
    if (!promoted && article.querySelector('[data-testid="card-website-cta-bar"]')) {
      promoted = true;
    }

    // Walk the article once to catch exact-text labels. Skip spans inside
    // tweetText, the quote wrapper, and the user-name block so we only flag
    // X's own chrome labels rather than text the author typed.
    const tweetText = article.querySelector('[data-testid="tweetText"]');
    const quoteWrapper = findQuoteWrapper(article);
    const userName = article.querySelector('[data-testid="User-Name"]');
    const spans = article.getElementsByTagName("span");
    for (let i = 0; i < spans.length; i++) {
      const el = spans[i];
      if (el.children.length !== 0) continue;
      if (tweetText && tweetText.contains(el)) continue;
      if (quoteWrapper && quoteWrapper.contains(el)) continue;
      if (userName && userName.contains(el)) continue;
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      if (!promoted && (txt === "Ad" || txt === "Promoted")) promoted = true;
      if (!madeWithAi && txt === "Made with AI") madeWithAi = true;
      if (promoted && madeWithAi) break;
    }
    return { promoted, madeWithAi };
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

  // X renders multiple `a[href*="/status/"]` anchors inside a single tweet:
  // the clean `/status/<id>` on the timestamp, plus sub-route variants like
  // `/status/<id>/analytics`, `/status/<id>/photo/<n>`, `/status/<id>/quotes`.
  // `querySelector` returns the first match in DOM order — on the Article
  // full-view page that's the /analytics anchor. Prefer the clean form.
  /**
   * @param {HTMLElement} scope
   * @returns {string}
   */
  function pickCleanStatusHref(scope) {
    const anchors = Array.from(scope.querySelectorAll('a[href*="/status/"]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (/\/status\/\d+(?:\?.*)?$/.test(href)) return href;
    }
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (/\/status\/\d+/.test(href)) return href;
    }
    return "";
  }

  // Full-view Article page nests a `twitterArticleReadView` inside the outer
  // tweet. Title sits in `twitter-article-title`; body text lives in a
  // Draft.js container (`longformRichTextComponent`) — not in `tweetText`.
  // Return both when present so the outer capture carries the actual article.
  /**
   * @param {HTMLElement} scope
   * @returns {{ title: string | null, body: string | null }}
   */
  function readArticleReadView(scope) {
    const readView = scope.querySelector('[data-testid="twitterArticleReadView"]');
    if (!readView) return { title: null, body: null };
    const titleEl = /** @type {HTMLElement | null} */ (
      readView.querySelector('[data-testid="twitter-article-title"]')
    );
    const bodyEl = /** @type {HTMLElement | null} */ (
      readView.querySelector('[data-testid="longformRichTextComponent"]')
    );
    const title = titleEl?.innerText.trim() || null;
    const body = bodyEl?.innerText.trim() || null;
    return { title, body };
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

  // X long-form Article cards render title + preview as plain `div[dir="auto"]`
  // nodes next to `[data-testid="article-cover-image"]` — no role="heading", no
  // `<h2>`. Scope to the cover image's parent so sibling text (and nothing else)
  // comes back; the "Article" chip uses `dir="ltr"` and is excluded naturally.
  /**
   * @param {HTMLElement} scope
   * @returns {{ title: string | null, preview: string | null }}
   */
  function readArticleCard(scope) {
    const cover = scope.querySelector('[data-testid="article-cover-image"]');
    const container = cover?.parentElement;
    if (!container) return { title: null, preview: null };
    const textNodes = Array.from(container.querySelectorAll('div[dir="auto"]'));
    const title =
      /** @type {HTMLElement | undefined} */ (textNodes[0])?.innerText.trim() || null;
    const preview =
      /** @type {HTMLElement | undefined} */ (textNodes[1])?.innerText.trim() || null;
    return { title, preview };
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
      // X-Article quote cards expose title + preview as plain divs. Fold them
      // into content whether or not an `/i/article/` anchor is present (quote
      // cards for long-form Articles typically omit it), so `content` carries
      // at least "Title: Preview..." for the reader.
      const card = readArticleCard(quoteWrapper);
      const articleSummary =
        card.title && card.preview
          ? `${card.title}: ${card.preview}`
          : card.title || card.preview || "";
      if (qArticleUrl) {
        const parts = [content, articleSummary, qArticleUrl].filter(Boolean);
        content = parts.join("\n");
      } else if (!content && articleSummary) {
        content = articleSummary;
      }
      // Last-ditch fallback: non-article cards sometimes expose a heading
      // but no cover image. Keep the old selector for that shape.
      if (!content) {
        const heading = /** @type {HTMLElement | null} */ (
          quoteWrapper.querySelector('[role="heading"], h2')
        );
        const headingText = heading ? heading.innerText.trim() : "";
        if (headingText) content = headingText;
      }
      const qStatusLink = quoteWrapper.querySelector('a[href*="/status/"]');
      const qStatusHref = qStatusLink?.getAttribute("href") || "";
      if (qStatusHref) {
        const url = new URL(qStatusHref, "https://x.com").toString();
        if (!content.includes(url)) {
          content = content ? `${content}\n${url}` : url;
        }
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
    if (!isExtAlive()) {
      teardownOnInvalidation();
      return;
    }
    try {
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
      chrome.runtime
        .sendMessage({ type: "bonsai:decision", payload: entry })
        .catch(() => {});
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai persistDecision failed", e);
    }
  }

  /** @param {string | null} postId */
  async function removeDecision(postId) {
    if (!isExtAlive()) {
      teardownOnInvalidation();
      return;
    }
    try {
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
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai removeDecision failed", e);
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
    // X nests a second `role="article"` inside the outer tweet on the
    // full-view Article page (`data-testid="twitterArticleReadView"`). The
    // inner article has no User-Name, no <time>, no tweetText — processing
    // it would double-capture under the same post_id and overwrite the
    // outer's good values with nulls. Skip it.
    if (article.getAttribute("data-testid") === "twitterArticleReadView") return;
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

    // Register for filter evaluation. Only posts with a stable postId can be
    // collapsed by decision (we need it as the dedup key in the batch call).
    if (payload.postId) {
      tracked.set(payload.postId, {
        article,
        header,
        footer,
        payload,
        hiddenBar: null,
        aiTag: null,
      });
      queueForFilter(payload.postId);
      maybeAttachAiTag(payload.postId);
    }
  }

  // --------------------------------------------------------------------------
  // Experimental AI-content tag. Renders next to the display name after the
  // detector endpoint classifies the tweet text. Non-blocking — missing or
  // slow responses leave the tweet unmarked. Cached in-memory per tab so a
  // scroll back doesn't re-query.
  // --------------------------------------------------------------------------

  /** @param {string} postId */
  function maybeAttachAiTag(postId) {
    if (!aiEnabled) return;
    const t = tracked.get(postId);
    if (!t) return;
    // Skip tweets with no classifiable text (media-only, pure link cards).
    const text = (t.payload.content || "").trim();
    if (!text) return;
    const userEl = findUserNameBlock(t.article);
    if (!userEl) return;
    const cached = detectCache.get(postId);
    if (cached) {
      paintAiTag(t, cached);
      return;
    }
    if (!t.aiTag) {
      const tag = createAiTag();
      tag.className = "bonsai-ai-tag bonsai-ai-tag--loading";
      tag.setAttribute("aria-label", "Bonsai: classifying");
      tag.title = "Bonsai: classifying";
      tag.appendChild(createSpinner());
      mountAiTag(userEl, tag);
      t.aiTag = tag;
    }
    queueForDetect(postId);
  }

  // Full User-Name block (display name + badge + handle + · + time). The tag
  // mounts at the end of this block so it sits to the right of the timestamp.
  /**
   * @param {HTMLElement} article
   * @returns {HTMLElement | null}
   */
  function findUserNameBlock(article) {
    return /** @type {HTMLElement | null} */ (
      article.querySelector('[data-testid="User-Name"]')
    );
  }

  function createAiTag() {
    const tag = document.createElement("span");
    tag.className = "bonsai-ai-tag";
    return tag;
  }

  // Inline SVG spinner — rendered via CSS rotation to avoid a URL asset.
  function createSpinner() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "bonsai-ai-tag__spinner");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "9");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "3");
    circle.setAttribute("stroke-linecap", "round");
    // Short arc — rotation sells the spin.
    circle.setAttribute("stroke-dasharray", "14 60");
    svg.appendChild(circle);
    return svg;
  }

  // X wraps the User-Name content in nested flex containers. The last leaf
  // flex row is where "· 8h" lives — appending the tag there keeps it on the
  // same line to the right of the timestamp. Fall back to appending to the
  // User-Name element itself on layouts where no deeper row exists.
  /**
   * @param {HTMLElement} userEl
   * @param {HTMLElement} tag
   */
  function mountAiTag(userEl, tag) {
    const rows = userEl.querySelectorAll("div");
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = /** @type {HTMLElement} */ (rows[i]);
      if (row.querySelector("time")) {
        row.appendChild(tag);
        return;
      }
    }
    userEl.appendChild(tag);
  }

  /**
   * @param {TrackedArticle} t
   * @param {BonsaiDetectorResult} result
   */
  function paintAiTag(t, result) {
    const userEl = findUserNameBlock(t.article);
    if (!userEl) return;
    let tag = t.aiTag;
    if (!tag) {
      tag = createAiTag();
      mountAiTag(userEl, tag);
      t.aiTag = tag;
    }
    const isAi = /^ai$/i.test(result.label);
    const pct = Math.round((result.confidence || 0) * 100);
    tag.className = "bonsai-ai-tag " + (isAi ? "bonsai-ai-tag--ai" : "bonsai-ai-tag--human");
    tag.textContent = `${isAi ? "AI" : "Human"}: ${pct}%`;
    tag.removeAttribute("aria-label");
    tag.title = `Bonsai detector (experimental) — ${result.label} ${pct}%`;
  }

  /** @param {string} postId */
  function queueForDetect(postId) {
    if (!aiEnabled) return;
    detectQueue.add(postId);
    if (detectTimer !== null) return;
    detectTimer = setTimeout(flushDetectQueue, DETECT_DEBOUNCE_MS);
  }

  async function flushDetectQueue() {
    detectTimer = null;
    if (!isExtAlive()) {
      teardownOnInvalidation();
      detectQueue.clear();
      return;
    }
    if (detectQueue.size === 0) return;
    const ids = Array.from(detectQueue).slice(0, DETECT_BATCH);
    for (const id of ids) detectQueue.delete(id);
    const items = ids
      .map((id) => tracked.get(id))
      .filter(/** @returns {t is TrackedArticle} */ (t) => Boolean(t))
      .map((t) => ({
        postId: /** @type {string} */ (t.payload.postId),
        text: (t.payload.content || "").trim(),
      }))
      .filter((i) => i.text);
    if (items.length === 0) {
      if (detectQueue.size > 0) {
        detectTimer = setTimeout(flushDetectQueue, DETECT_DEBOUNCE_MS);
      }
      return;
    }
    /** @type {{ results?: BonsaiDetectorResult[], skipped?: true }} */
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "bonsai:detect", items });
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai detect message failed", e);
      return;
    }
    if (res && !res.skipped && Array.isArray(res.results)) {
      for (const r of res.results) {
        detectCache.set(r.postId, r);
        const t = tracked.get(r.postId);
        if (t) paintAiTag(t, r);
      }
    }
    if (detectQueue.size > 0) {
      detectTimer = setTimeout(flushDetectQueue, DETECT_DEBOUNCE_MS);
    }
  }

  function requeueAllDetect() {
    if (!aiEnabled) {
      for (const t of tracked.values()) removeAiTag(t);
      return;
    }
    for (const id of tracked.keys()) {
      if (!detectCache.has(id)) maybeAttachAiTag(id);
      else {
        const cached = detectCache.get(id);
        const t = tracked.get(id);
        if (cached && t) paintAiTag(t, cached);
      }
    }
  }

  /** @param {TrackedArticle} t */
  function removeAiTag(t) {
    if (t.aiTag) {
      t.aiTag.remove();
      t.aiTag = null;
    }
  }

  // --------------------------------------------------------------------------
  // Hide/show filter — batches visible articles to the backend, collapses
  // any that come back with hide=true. Also respects live changes to filter
  // prefs by re-sweeping all tracked articles on storage.onChanged.
  // --------------------------------------------------------------------------
  /** @param {string} postId */
  function queueForFilter(postId) {
    filterQueue.add(postId);
    if (filterTimer !== null) return;
    filterTimer = setTimeout(flushFilterQueue, FILTER_DEBOUNCE_MS);
  }

  async function flushFilterQueue() {
    filterTimer = null;
    if (!isExtAlive()) {
      teardownOnInvalidation();
      filterQueue.clear();
      return;
    }
    if (filterQueue.size === 0) return;
    const ids = Array.from(filterQueue);
    filterQueue.clear();
    const posts = ids
      .map((id) => tracked.get(id))
      .filter(/** @returns {t is TrackedArticle} */ (t) => Boolean(t))
      .map((t) => {
        // Re-detect ad flags right before sending — X hydrates the "Made
        // with AI" chip and some promoted card shells after the article
        // first mounts, so the attach-time read can be stale.
        const fresh = detectAdFlags(t.article);
        t.payload.isPromoted = fresh.promoted;
        t.payload.isMadeWithAi = fresh.madeWithAi;
        return {
          postId: /** @type {string} */ (t.payload.postId),
          content: t.payload.content,
          authorName: t.payload.authorName,
          authorHandle: t.payload.authorHandle,
          isPromoted: fresh.promoted,
          isMadeWithAi: fresh.madeWithAi,
        };
      });
    if (posts.length === 0) return;
    /** @type {{ decisions?: Array<{ postId: string, hide: boolean, reason?: string | null }>, skipped?: true }} */
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "bonsai:filter", posts });
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai filter message failed", e);
      return;
    }
    if (!res || res.skipped || !Array.isArray(res.decisions)) return;
    for (const d of res.decisions) {
      applyDecision(d.postId, Boolean(d.hide), d.reason || null);
    }
  }

  /**
   * @param {string} postId
   * @param {boolean} hide
   * @param {string | null} reason
   */
  function applyDecision(postId, hide, reason) {
    const t = tracked.get(postId);
    if (!t) return;
    if (hide) collapseArticle(t, reason);
    else revealArticle(t);
  }

  /**
   * @param {TrackedArticle} t
   * @param {string | null} reason
   */
  function collapseArticle(t, reason) {
    if (t.hiddenBar) {
      updateHiddenBarReason(t.hiddenBar, reason);
      return;
    }
    const bar = document.createElement("div");
    bar.className = "bonsai-hidden";
    bar.dataset.bonsaiHiddenReason = reason || "";
    bar.innerHTML = `
      <span class="bonsai-hidden__dot" aria-hidden="true"></span>
      <span class="bonsai-hidden__label">Hidden by Bonsai</span>
      <span class="bonsai-hidden__reason"></span>
      <button type="button" class="bonsai-hidden__show">Show</button>
    `;
    const reasonEl = /** @type {HTMLElement} */ (bar.querySelector(".bonsai-hidden__reason"));
    reasonEl.textContent = formatReason(reason);
    const showBtn = /** @type {HTMLButtonElement} */ (bar.querySelector(".bonsai-hidden__show"));
    showBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      revealArticle(t);
    });

    // Insert the bar where the header lived so vertical rhythm stays steady.
    const anchor = t.header.parentNode ? t.header : t.article;
    const parent = anchor.parentNode;
    if (parent) parent.insertBefore(bar, anchor);
    t.hiddenBar = bar;

    t.header.style.display = "none";
    t.footer.style.display = "none";
    t.article.style.display = "none";
    t.article.dataset.bonsaiHidden = "1";
  }

  /** @param {TrackedArticle} t */
  function revealArticle(t) {
    if (!t.hiddenBar && !t.article.dataset.bonsaiHidden) return;
    if (t.hiddenBar) {
      t.hiddenBar.remove();
      t.hiddenBar = null;
    }
    t.header.style.display = "";
    t.footer.style.display = "";
    t.article.style.display = "";
    delete t.article.dataset.bonsaiHidden;
  }

  /**
   * @param {HTMLElement} bar
   * @param {string | null} reason
   */
  function updateHiddenBarReason(bar, reason) {
    bar.dataset.bonsaiHiddenReason = reason || "";
    const reasonEl = /** @type {HTMLElement | null} */ (
      bar.querySelector(".bonsai-hidden__reason")
    );
    if (reasonEl) reasonEl.textContent = formatReason(reason);
  }

  /** @param {string | null} reason */
  function formatReason(reason) {
    if (!reason) return "";
    if (reason === "ad") return "Ad";
    if (reason === "made-with-ai") return "Made with AI";
    if (reason.startsWith("muted:")) return `Muted: ${reason.slice("muted:".length)}`;
    return reason;
  }

  // Re-sweep every tracked article when filter prefs change from the popup.
  // Cheap — one batched call to the backend regardless of how many are on
  // screen, same debounce as the scroll path.
  function requeueAll() {
    for (const id of tracked.keys()) filterQueue.add(id);
    if (filterTimer !== null) return;
    filterTimer = setTimeout(flushFilterQueue, FILTER_DEBOUNCE_MS);
  }

  // --------------------------------------------------------------------------
  // First-visit coach overlay — a floating card that nudges the user to rate
  // their first post. Only shows for users who finished popup onboarding and
  // haven't dismissed it. Clears itself on first rating or explicit close.
  // --------------------------------------------------------------------------
  async function maybeShowCoach() {
    if (!isExtAlive()) {
      teardownOnInvalidation();
      return;
    }
    try {
      const { [ONBOARDED_KEY]: onboarded, [COACH_KEY]: seen } =
        await chrome.storage.local.get([ONBOARDED_KEY, COACH_KEY]);
      if (!onboarded || seen) return;
      mountCoach();
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai maybeShowCoach failed", e);
    }
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
    if (!isExtAlive()) {
      teardownOnInvalidation();
      return;
    }
    try {
      chrome.storage.local.set({ [COACH_KEY]: true }).catch(() => {});
    } catch {
      teardownOnInvalidation();
    }
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
    if (!isExtAlive()) {
      teardownOnInvalidation();
      return;
    }
    try {
      const { [STORAGE_KEY]: raw } = await chrome.storage.local.get(STORAGE_KEY);
      const captures = /** @type {BonsaiCapture[]} */ (raw || []);
      paintProgress(captures);
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai refreshProgress failed", e);
    }
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

  domObserver = new MutationObserver((muts) => {
    if (!isExtAlive()) {
      teardownOnInvalidation();
      return;
    }
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

  async function refreshAiEnabled() {
    if (!isExtAlive()) return;
    try {
      /** @type {BonsaiConfig} */
      const cfg = await chrome.runtime.sendMessage({ type: "bonsai:getConfig" });
      const next = Boolean(cfg?.experimentalAiDetector) && Boolean(cfg?.detectorBaseUrl);
      if (next === aiEnabled) return;
      aiEnabled = next;
      requeueAllDetect();
    } catch (e) {
      if (!isExtAlive()) teardownOnInvalidation();
      else console.warn("bonsai refreshAiEnabled failed", e);
    }
  }

  function boot() {
    scan(document);
    if (domObserver) domObserver.observe(document.body, { childList: true, subtree: true });
    mountProgress();
    refreshProgress();
    refreshAiEnabled();
    if (!isExtAlive()) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) {
        const next = /** @type {BonsaiCapture[] | undefined} */ (
          changes[STORAGE_KEY].newValue
        );
        paintProgress(next || []);
      }
      // Filter prefs or sign-in state changed — re-evaluate every tracked
      // article. Prefs flip from the popup should take effect without a
      // page reload; a fresh sign-in means the endpoint will now answer.
      if (changes[FILTERS_KEY] || changes["bonsaiUser"]) {
        requeueAll();
      }
      // Experimental AI-detector toggle or detector URL changed in the
      // popup / background — flip tag rendering without a reload.
      if (changes["bonsaiConfig"]) {
        refreshAiEnabled();
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
