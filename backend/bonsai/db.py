"""Firestore client singleton.

Uses Application Default Credentials:
  * Cloud Run: service account identity from the metadata server.
  * Local: credentials from `gcloud auth application-default login`, or a
    service-account JSON pointed at by GOOGLE_APPLICATION_CREDENTIALS.
"""

from __future__ import annotations

from functools import lru_cache

from google.cloud import firestore

from .config import Settings, get_settings


@lru_cache(maxsize=1)
def get_client() -> firestore.Client:
    s = get_settings()
    kwargs: dict[str, str] = {}
    if s.gcp_project_id:
        kwargs["project"] = s.gcp_project_id
    if s.firestore_database and s.firestore_database != "(default)":
        kwargs["database"] = s.firestore_database
    return firestore.Client(**kwargs)


def doc_id(user_sub: str, post_id: str) -> str:
    """Stable document id — one row per (user, post). Enables idempotent upsert."""
    return f"{user_sub}_{post_id}"


def collection_ref(settings: Settings | None = None):
    s = settings or get_settings()
    return get_client().collection(s.firestore_collection)
