"""One-off cleanup: delete the orphan `article_url` field (and
`quoted.article_url`) from every doc in bonsai_posts.

Field was added briefly in v0.8.32-0.8.34 and removed in v0.8.35; the extension
stopped writing it but Firestore's merge-upsert never deletes fields, so old
docs still carry `article_url: null`. This script sweeps the collection once.

Idempotent — safe to re-run; docs with no article_url field are skipped.

Usage:
    cd backend && uv run python scripts/cleanup_article_url.py [--dry-run]

Requires ADC (gcloud auth application-default login).
"""

from __future__ import annotations

import argparse
import sys

from google.cloud import firestore

PROJECT_ID = "bonsai-feed-filter"
COLLECTION = "bonsai_posts"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="count, don't write")
    args = parser.parse_args()

    client = firestore.Client(project=PROJECT_ID)
    coll = client.collection(COLLECTION)

    scanned = 0
    outer_hits = 0
    quoted_hits = 0
    writes = 0

    for snap in coll.stream():
        scanned += 1
        data = snap.to_dict() or {}
        update: dict = {}
        if "article_url" in data:
            outer_hits += 1
            update["article_url"] = firestore.DELETE_FIELD
        quoted = data.get("quoted")
        if isinstance(quoted, dict) and "article_url" in quoted:
            quoted_hits += 1
            cleaned = {k: v for k, v in quoted.items() if k != "article_url"}
            update["quoted"] = cleaned
        if not update:
            continue
        if args.dry_run:
            continue
        snap.reference.update(update)
        writes += 1

    print(
        f"scanned={scanned} outer_hits={outer_hits} quoted_hits={quoted_hits} "
        f"writes={writes} dry_run={args.dry_run}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
