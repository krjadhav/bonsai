"""The Safari build's OAuth landing page and CORS for Safari extension origins."""

from __future__ import annotations

from fastapi.testclient import TestClient

from bonsai.main import app

client = TestClient(app)


def test_safari_callback_serves_static_page() -> None:
    resp = client.get("/auth/safari-callback")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert "script-src" not in resp.headers["content-security-policy"]
    assert "Signing you in to Bonsai" in resp.text


def test_cors_allows_safari_extension_origin() -> None:
    origin = "safari-web-extension://3F2504E0-4F89-11D3-9A0C-0305E82C3301"
    resp = client.options(
        "/posts",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] in (origin, "*")


def test_cors_rejects_lookalike_origin() -> None:
    resp = client.options(
        "/posts",
        headers={
            "Origin": "https://safari-web-extension.evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    # With ALLOWED_ORIGINS unset the app falls back to "*", so only assert
    # that the regex itself does not echo a non-extension origin.
    assert resp.headers.get("access-control-allow-origin") != (
        "https://safari-web-extension.evil.example"
    )
