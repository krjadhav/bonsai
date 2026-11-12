"""Google token verification.

The extension sends an OAuth access token in the Authorization header. We
verify it by calling Google's tokeninfo endpoint, then cross-check the audience
against our configured client id. This avoids pulling in the full ID-token
verification flow (which requires cert fetching) and keeps dependencies small.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import Depends, HTTPException, Request, status

from .config import Settings, get_settings

TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"


@dataclass(frozen=True)
class AuthUser:
    sub: str
    email: str


async def verify_token(token: str, settings: Settings) -> AuthUser:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(TOKENINFO_URL, params={"access_token": token})
    if resp.status_code != 200:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="token rejected by Google")
    data = resp.json()
    aud = data.get("aud") or data.get("azp")
    if settings.google_oauth_client_id and aud != settings.google_oauth_client_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="token audience mismatch")
    email = data.get("email")
    sub = data.get("sub") or data.get("user_id")
    if not email or not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="token missing identity claims")
    return AuthUser(sub=sub, email=email)


async def current_user(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> AuthUser:
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = header.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="empty token")
    return await verify_token(token, settings)
