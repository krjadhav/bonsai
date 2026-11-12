"""Supabase client singleton.

We use the supabase-py client so this file stays small — one table, one upsert.
If we ever need streaming/bulk performance we can drop to direct Postgres via
asyncpg, but for Stage 2 volumes the HTTP client is cheaper to reason about.
"""

from __future__ import annotations

from functools import lru_cache

from supabase import Client, create_client

from .config import get_settings

TABLE = "bonsai_posts"


@lru_cache(maxsize=1)
def get_client() -> Client:
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY not configured")
    return create_client(s.supabase_url, s.supabase_service_key)
