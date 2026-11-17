"""FastAPI app entrypoint.

Routes:
  GET  /health         -> liveness check, no auth
  POST /posts          -> upsert a single capture (auth required)

Design notes:
  * One Firestore document per (user_sub, post_id). Upsert via set(merge=True)
    so repeated scrolls cost one write per unique post, not one per scroll.
  * Stateless — Cloud Run scales from zero. Firestore client is reused via
    lru_cache; cold starts pay one connection setup.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.cloud.firestore import SERVER_TIMESTAMP
from google.cloud.firestore_v1.base_query import FieldFilter

from .auth import AuthUser, current_user
from .config import get_settings
from .db import collection_ref, doc_id
from .schemas import PostIn, PostListOut, PostOut, PostRecord

log = logging.getLogger("bonsai")

app = FastAPI(title="Bonsai ingest", version="0.3.0")

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins) or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


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
        "captured_at",
        "decided_at",
        "decision",
    }
    return {k: v for k, v in doc.items() if k in allowed}
