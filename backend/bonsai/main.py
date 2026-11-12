"""FastAPI app entrypoint.

Routes:
  GET  /health         -> liveness check, no auth
  POST /posts          -> ingest a single capture (auth required)

Intentionally single-endpoint: the extension sends captures one at a time, the
server dedupes via a unique(user_email, post_id) index so repeated scrolls
don't bloat the table.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import AuthUser, current_user
from .config import get_settings
from .db import TABLE, get_client
from .schemas import PostIn, PostOut

app = FastAPI(title="Bonsai ingest", version="0.1.0")

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
    row = {
        "user_email": user.email,
        "user_sub": user.sub,
        "post_id": payload.post_id,
        "permalink": payload.permalink,
        "author_name": payload.author_name,
        "author_handle": payload.author_handle,
        "content": payload.content,
        "tweeted_at": payload.tweeted_at.isoformat() if payload.tweeted_at else None,
        "has_media": payload.has_media,
        "media_types": payload.media_types or [],
        "decision": payload.decision,
        "captured_at": payload.captured_at.isoformat() if payload.captured_at else None,
        "decided_at": payload.decided_at.isoformat() if payload.decided_at else None,
    }
    try:
        client = get_client()
        resp = client.table(TABLE).upsert(row, on_conflict="user_email,post_id").execute()
    except Exception as exc:  # pragma: no cover - external failure
        raise HTTPException(status_code=502, detail=f"supabase upsert failed: {exc}") from exc

    inserted = bool(resp.data)
    return PostOut(ok=True, post_id=payload.post_id, inserted=inserted)
