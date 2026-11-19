"""FastAPI entrypoint for the Bonsai AI-content detector.

Routes:
  GET  /health   -> liveness check; reports whether the model is loaded.
  POST /detect   -> batch classify texts as AI or Human with confidence.

Design notes:
  * No auth. Endpoint is public; rate-ceiling comes from --max-instances
    and request concurrency on Cloud Run.
  * Model load is lazy — first POST /detect pays cold start.
  * CORS allow-list matches `ALLOWED_ORIGINS` env (comma-separated), with
    `*` fallback so the extension works across unpacked / packed ids
    during experimental testing.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .model import MODEL_ID, detector

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bonsai.detector")

app = FastAPI(title="Bonsai detector", version="0.1.0")

_origins_raw = os.getenv("ALLOWED_ORIGINS", "")
_origins = [o.strip() for o in _origins_raw.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class DetectItem(BaseModel):
    post_id: str = Field(..., max_length=128)
    text: str = Field(default="", max_length=8000)


class DetectIn(BaseModel):
    items: list[DetectItem] = Field(default_factory=list, max_length=32)


class DetectResult(BaseModel):
    post_id: str
    label: str
    confidence: float


class DetectOut(BaseModel):
    results: list[DetectResult]


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "version": app.version,
        "model_id": MODEL_ID,
        "model_loaded": bool(detector._loaded),  # noqa: SLF001 — read-only probe
    }


@app.post("/detect", response_model=DetectOut)
async def detect_texts(payload: DetectIn) -> DetectOut:
    if not payload.items:
        return DetectOut(results=[])
    texts = [i.text for i in payload.items]
    try:
        results = await detector.detect(texts)
    except Exception as exc:
        log.exception("detector inference failed")
        raise HTTPException(status_code=502, detail=f"inference failed: {exc}") from exc
    return DetectOut(
        results=[
            DetectResult(
                post_id=payload.items[i].post_id,
                label=r.label,
                confidence=round(r.confidence, 4),
            )
            for i, r in enumerate(results)
        ]
    )
