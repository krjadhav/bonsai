"""Pydantic schemas for the ingest API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Decision = Literal["yes", "no"]


class QuotedPost(BaseModel):
    """The post embedded inside a quote tweet. authorName/authorHandle refer
    to the ORIGINAL author of the quoted content, not the quoter."""

    author_name: str | None = Field(default=None, alias="authorName")
    author_handle: str | None = Field(default=None, alias="authorHandle")
    content: str | None = None

    model_config = {"populate_by_name": True}


class PostIn(BaseModel):
    post_id: str = Field(alias="postId", min_length=1, max_length=64)
    permalink: str | None = None
    author_name: str | None = Field(default=None, alias="authorName")
    author_handle: str | None = Field(default=None, alias="authorHandle")
    content: str | None = None
    tweeted_at: datetime | None = Field(default=None, alias="tweetedAt")
    has_media: bool = Field(default=False, alias="hasMedia")
    media_types: list[str] = Field(default_factory=list, alias="mediaTypes")
    # Set when the capture reached the user as a plain retweet. The outer
    # author fields still describe the original tweet's author.
    reposted_by: str | None = Field(default=None, alias="repostedBy")
    # Set when the article is a quote tweet.
    quoted: QuotedPost | None = None
    captured_at: datetime | None = Field(default=None, alias="capturedAt")
    decided_at: datetime | None = Field(default=None, alias="decidedAt")
    decision: Decision | None = None

    model_config = {"populate_by_name": True}


class PostOut(BaseModel):
    ok: bool
    post_id: str
    inserted: bool


class PostRecord(BaseModel):
    """A single user capture read back from Firestore for hydration."""

    post_id: str = Field(serialization_alias="postId")
    permalink: str | None = None
    author_name: str | None = Field(default=None, serialization_alias="authorName")
    author_handle: str | None = Field(default=None, serialization_alias="authorHandle")
    content: str | None = None
    tweeted_at: datetime | None = Field(default=None, serialization_alias="tweetedAt")
    has_media: bool = Field(default=False, serialization_alias="hasMedia")
    media_types: list[str] = Field(default_factory=list, serialization_alias="mediaTypes")
    reposted_by: str | None = Field(default=None, serialization_alias="repostedBy")
    quoted: QuotedPost | None = None
    captured_at: datetime | None = Field(default=None, serialization_alias="capturedAt")
    decided_at: datetime | None = Field(default=None, serialization_alias="decidedAt")
    decision: Decision | None = None

    model_config = {"populate_by_name": True}


class PostListOut(BaseModel):
    items: list[PostRecord]
    count: int
