"""FastAPI app entrypoint.

Routes:
  GET    /health             -> liveness check, no auth
  GET    /auth/safari-callback -> OAuth redirect landing page for the Safari
                                  build (no auth; token stays in the fragment)
  POST   /posts              -> upsert a single capture (auth required)
  GET    /posts              -> list this user's captures (auth required)
  DELETE /posts/{post_id}    -> remove a single capture (auth required)
  POST   /filter             -> batch hide/show decisions (auth required)

Design notes:
  * One Firestore document per (user_sub, post_id). Upsert via set(merge=True)
    so repeated scrolls cost one write per unique post, not one per scroll.
  * Stateless — Cloud Run scales from zero. Firestore client is reused via
    lru_cache; cold starts pay one connection setup.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from google.cloud.firestore import SERVER_TIMESTAMP
from google.cloud.firestore_v1.base_query import FieldFilter

from .auth import AuthUser, current_user
from .config import get_settings
from .db import collection_ref, doc_id
from .schemas import (
    FilterDecision,
    FilterIn,
    FilterOut,
    PostIn,
    PostListOut,
    PostOut,
    PostRecord,
)

log = logging.getLogger("bonsai")

app = FastAPI(title="Bonsai ingest", version="0.3.0")

settings = get_settings()
SAFARI_EXTENSION_ORIGIN_REGEX = r"safari-web-extension://[0-9A-Fa-f-]+"
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins) or ["*"],
    # Safari gives every install its own random extension origin, so it can't
    # be listed in ALLOWED_ORIGINS. Auth is a bearer token (no cookies), so
    # matching the scheme is enough.
    allow_origin_regex=SAFARI_EXTENSION_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


# Google redirects the Safari build here after sign-in, with the access token
# in the URL fragment. Browsers never send the fragment to the server, so this
# handler only serves a static page; the extension's content script
# (extension/oauth-callback.js) reads the fragment and hands it to the
# background, which closes the tab. Chrome keeps using chromiumapp.org.
SAFARI_CALLBACK_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bonsai sign-in</title>
<style>
  body { font: 16px -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px;
         text-align: center; color: #1f2a1f; background: #f6f8f3; }
  @media (prefers-color-scheme: dark) { body { color: #e6ede3; background: #141a14; } }
</style>
</head>
<body>
<h1>Signing you in to Bonsai</h1>
<p>This tab closes on its own. If it stays open, tap the Bonsai extension
in Safari and allow it on this site, then reload.</p>
</body>
</html>
"""


@app.get("/auth/safari-callback", response_class=HTMLResponse, include_in_schema=False)
async def safari_oauth_callback() -> HTMLResponse:
    return HTMLResponse(
        SAFARI_CALLBACK_HTML,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/posts", response_model=PostOut)
async def ingest_post(
    payload: PostIn,
    user: AuthUser = Depends(current_user),
) -> PostOut:
    now = datetime.now(UTC)
    doc = {
        "user_email": user.email,
        "user_sub": user.sub,
        "post_id": payload.post_id,
        "permalink": payload.permalink,
        "author_name": payload.author_name,
        "author_handle": payload.author_handle,
        "content": payload.content,
        "tweeted_at": payload.tweeted_at,
        "has_media": payload.has_media,
        "media_types": payload.media_types or [],
        "reposted_by": payload.reposted_by,
        "quoted": payload.quoted.model_dump() if payload.quoted else None,
        "thumbnail_url": payload.thumbnail_url,
        "decision": payload.decision,
        "captured_at": payload.captured_at or now,
        "decided_at": payload.decided_at,
        "updated_at": SERVER_TIMESTAMP,
    }
    try:
        ref = collection_ref().document(doc_id(user.sub, payload.post_id))
        ref.set(doc, merge=True)
    except Exception as exc:
        log.exception("firestore upsert failed for %s", payload.post_id)
        raise HTTPException(status_code=502, detail=f"firestore upsert failed: {exc}") from exc

    return PostOut(ok=True, post_id=payload.post_id, inserted=True)


@app.delete("/posts/{post_id}", response_model=PostOut)
async def delete_post(
    post_id: str,
    user: AuthUser = Depends(current_user),
) -> PostOut:
    """Delete this user's capture for `post_id`. Idempotent — missing doc
    still returns ok so the extension can retry a queued tombstone without
    special-casing 404."""
    if not post_id or len(post_id) > 64:
        raise HTTPException(status_code=400, detail="invalid post_id")
    try:
        ref = collection_ref().document(doc_id(user.sub, post_id))
        ref.delete()
    except Exception as exc:
        log.exception("firestore delete failed for %s", post_id)
        raise HTTPException(status_code=502, detail=f"firestore delete failed: {exc}") from exc
    return PostOut(ok=True, post_id=post_id, inserted=False)


@app.get("/posts", response_model=PostListOut)
async def list_posts(
    user: AuthUser = Depends(current_user),
) -> PostListOut:
    """Return every capture this user has ever submitted. Used by the extension
    to rehydrate local storage after reinstall or on a new device so the
    teaching-progress bar and sidebar reflect the real total, not just what
    survived on this install."""
    try:
        query = collection_ref().where(filter=FieldFilter("user_sub", "==", user.sub))
        items = [PostRecord(**_normalize(doc.to_dict() or {})) for doc in query.stream()]
    except Exception as exc:
        log.exception("firestore list failed for sub=%s", user.sub)
        raise HTTPException(status_code=502, detail=f"firestore list failed: {exc}") from exc
    return PostListOut(items=items, count=len(items))


@app.post("/filter", response_model=FilterOut)
async def filter_posts(
    payload: FilterIn,
    user: AuthUser = Depends(current_user),
) -> FilterOut:
    """Return a hide/show decision per post in `payload.posts`.

    Stub mechanism — two deterministic rules:
      1. hide_ads + is_promoted -> hide, reason="ad"
      2. any muted word (case-insensitive substring) in content / author
         fields -> hide, reason="muted:<word>"

    Pure function of input. No Firestore reads/writes. Auth is still required
    so the request carries a user identity: future personalization will key
    off `user.sub` for per-user models without a schema change here.
    """
    _ = user  # reserved for personalized ranking; present today for auth.
    # Word-boundary match so short terms ("ai") don't false-positive inside
    # longer words ("plain"). Each muted word is compiled once per request.
    muted_patterns: list[tuple[str, re.Pattern[str]]] = []
    for raw in payload.filters.muted_words:
        if not raw or not raw.strip():
            continue
        word = raw.strip()
        muted_patterns.append((word.lower(), re.compile(rf"\b{re.escape(word)}\b", re.IGNORECASE)))
    decisions: list[FilterDecision] = []
    for post in payload.posts:
        hide = False
        reason: str | None = None
        if payload.filters.hide_ads:
            if post.is_promoted:
                hide = True
                reason = "ad"
            elif post.is_made_with_ai:
                hide = True
                reason = "made-with-ai"
        if not hide and muted_patterns:
            haystack = " ".join(
                s for s in (post.content, post.author_name, post.author_handle) if s
            )
            for word, pattern in muted_patterns:
                if pattern.search(haystack):
                    hide = True
                    reason = f"muted:{word}"
                    break
        decisions.append(FilterDecision(post_id=post.post_id, hide=hide, reason=reason))
    return FilterOut(decisions=decisions)


def _normalize(doc: dict) -> dict:
    """Trim fields Firestore returns that PostRecord doesn't model."""
    allowed = {
        "post_id",
        "permalink",
        "author_name",
        "author_handle",
        "content",
        "tweeted_at",
        "has_media",
        "media_types",
        "reposted_by",
        "quoted",
        "thumbnail_url",
        "captured_at",
        "decided_at",
        "decision",
    }
    return {k: v for k, v in doc.items() if k in allowed}
