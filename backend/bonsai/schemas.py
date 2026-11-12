"""Pydantic schemas for the ingest API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Decision = Literal["yes", "no"]


class PostIn(BaseModel):
    post_id: str = Field(alias="postId", min_length=1, max_length=64)
    permalink: str | None = None
    author_name: str | None = Field(default=None, alias="authorName")
    author_handle: str | None = Field(default=None, alias="authorHandle")
    content: str | None = None
    tweeted_at: datetime | None = Field(default=None, alias="tweetedAt")
    has_media: bool = Field(default=False, alias="hasMedia")
    media_types: list[str] = Field(default_factory=list, alias="mediaTypes")
    captured_at: datetime | None = Field(default=None, alias="capturedAt")
    decided_at: datetime | None = Field(default=None, alias="decidedAt")
    decision: Decision | None = None

    model_config = {"populate_by_name": True}


class PostOut(BaseModel):
    ok: bool
    post_id: str
    inserted: bool
