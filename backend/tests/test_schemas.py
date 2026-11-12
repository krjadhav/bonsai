"""Schema sanity — exercises alias handling so the extension's camelCase
payloads round-trip cleanly without hitting Supabase."""

from __future__ import annotations

from datetime import UTC, datetime

from bonsai.schemas import PostIn


def test_post_in_accepts_camel_case_payload() -> None:
    payload = {
        "postId": "1234567890",
        "permalink": "https://x.com/u/status/1234567890",
        "authorName": "Jane Doe",
        "authorHandle": "@jane",
        "content": "hello",
        "tweetedAt": "2026-11-01T12:00:00Z",
        "hasMedia": True,
        "mediaTypes": ["image"],
        "capturedAt": "2026-11-01T12:05:00Z",
        "decision": "yes",
    }
    parsed = PostIn.model_validate(payload)
    assert parsed.post_id == "1234567890"
    assert parsed.author_handle == "@jane"
    assert parsed.has_media is True
    assert parsed.media_types == ["image"]
    assert parsed.decision == "yes"
    assert parsed.tweeted_at == datetime(2026, 11, 1, 12, 0, tzinfo=UTC)


def test_post_in_minimal_payload() -> None:
    parsed = PostIn.model_validate({"postId": "1"})
    assert parsed.post_id == "1"
    assert parsed.decision is None
    assert parsed.media_types == []
