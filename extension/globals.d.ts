// Ambient globals used across the Bonsai extension.

interface Window {
  __bonsaiInjected?: boolean;
}

interface BonsaiUser {
  email: string;
  name?: string;
  picture?: string;
  sub: string;
  token: string;
  // Unix ms when the current access token was issued. Used to schedule
  // silent prompt=none reauth before Google's ~60-minute expiry window.
  tokenIssuedAt?: number;
  // True when the backend most recently returned 401 for this token. The
  // extension keeps the user record around (so captures stay associated with
  // the right identity) but pauses sync and surfaces a re-sign-in CTA in the
  // popup. Cleared on the next successful sign-in.
  stale?: boolean;
}

interface BonsaiQuotedPost {
  authorName: string | null;
  authorHandle: string | null;
  content: string;
  // When the quoted post is an X long-form Article, this points at its
  // `/i/article/<id>` viewer URL. Null for ordinary quote tweets.
  articleUrl?: string | null;
}

interface BonsaiCapture {
  postId: string | null;
  permalink: string | null;
  authorName: string | null;
  authorHandle: string | null;
  content: string;
  tweetedAt: string | null;
  hasMedia: boolean;
  mediaTypes: string[];
  // Reposter display name when the capture surfaced in the timeline via a
  // plain retweet. The article's own authorName is still the ORIGINAL author
  // in that case — X renders retweets as the original tweet with a social
  // context chip above it. Null for ordinary posts.
  repostedBy: string | null;
  // Set when the article is a quote tweet: the outer authorName/content is
  // the quoter's commentary; `quoted` holds what they quoted.
  quoted: BonsaiQuotedPost | null;
  // Best-effort preview image URL for the post's media (video poster or first
  // image). Points at pbs.twimg.com — stored as a link so sanity checks can
  // open it directly. Null when the article has no media or the poster/img
  // hasn't hydrated yet.
  thumbnailUrl: string | null;
  // Absolute URL of the X long-form Article viewer (`/i/article/<id>`) when
  // the capture is an Article or embeds one. Null for ordinary tweets. Set
  // on the outer capture even when the Article was reposted — ensures the
  // link to the content survives even if the body text isn't inline.
  articleUrl?: string | null;
  capturedAt: string;
  decision: "yes" | "no" | null;
  decidedAt?: string;
}

interface BonsaiConfig {
  apiBaseUrl: string;
}
