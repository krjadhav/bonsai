"""Runtime configuration pulled from environment variables.

Kept intentionally dependency-light — no pydantic-settings. On Cloud Run the
service account's Application Default Credentials cover Firestore access, so
no key file is needed in production.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    gcp_project_id: str
    firestore_database: str
    firestore_collection: str
    google_oauth_client_id: str
    allowed_origins: tuple[str, ...]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    origins_raw = os.getenv("ALLOWED_ORIGINS", "")
    origins = tuple(o.strip() for o in origins_raw.split(",") if o.strip())
    return Settings(
        gcp_project_id=os.getenv("GCP_PROJECT_ID", ""),
        firestore_database=os.getenv("FIRESTORE_DATABASE", "(default)"),
        firestore_collection=os.getenv("FIRESTORE_COLLECTION", "bonsai_posts"),
        google_oauth_client_id=os.getenv("GOOGLE_OAUTH_CLIENT_ID", ""),
        allowed_origins=origins,
    )
