"""Runtime configuration pulled from environment variables.

Keep this module tiny — we deliberately do not use pydantic-settings to avoid
an extra dependency. All fields are read once at import time and cached.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_service_key: str
    google_oauth_client_id: str
    allowed_origins: tuple[str, ...]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    origins_raw = os.getenv("ALLOWED_ORIGINS", "")
    origins = tuple(o.strip() for o in origins_raw.split(",") if o.strip())
    return Settings(
        supabase_url=os.getenv("SUPABASE_URL", ""),
        supabase_service_key=os.getenv("SUPABASE_SERVICE_KEY", ""),
        google_oauth_client_id=os.getenv("GOOGLE_OAUTH_CLIENT_ID", ""),
        allowed_origins=origins,
    )
