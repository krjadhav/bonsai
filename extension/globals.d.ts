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

interface BonsaiCapture {
  postId: string | null;
  permalink: string | null;
  authorName: string | null;
  authorHandle: string | null;
  content: string;
  tweetedAt: string | null;
  hasMedia: boolean;
  mediaTypes: string[];
  capturedAt: string;
  decision: "yes" | "no" | null;
  decidedAt?: string;
}

interface BonsaiConfig {
  apiBaseUrl: string;
}
