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
}

interface BonsaiQuotedPost {
  authorName: string | null;
  authorHandle: string | null;
  content: string;
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
  capturedAt: string;
  decision: "yes" | "no" | null;
  decidedAt?: string;
}

interface BonsaiConfig {
  apiBaseUrl: string;
}
