#!/usr/bin/env bash
# Wipe all sign-in state for a given user — Firestore docs + extension
# storage — so the next sign-in starts clean. Intended for repeatable
# end-to-end testing, not production incident response.
#
# Usage:
#   ./scripts/reset-signin.sh <email>
#
# Example:
#   ./scripts/reset-signin.sh j@dhav.me
#
# Prerequisites:
#   * gcloud auth application-default login (ADC for Firestore access)
#   * uv installed (used to run the backend's Python env for deletion)

set -euo pipefail

EMAIL="${1:-}"
if [[ -z "$EMAIL" ]]; then
  echo "usage: $0 <email>"
  exit 1
fi

PROJECT="bonsai-feed-filter"
COLLECTION="bonsai_posts"

printf '\n==> Resetting sign-in state for %s\n' "$EMAIL"
printf '    Firestore project: %s\n' "$PROJECT"
printf '    collection:        %s\n\n' "$COLLECTION"

read -r -p "This deletes ALL Firestore docs for ${EMAIL}. Continue? [y/N] " ANS
if [[ "$ANS" != "y" && "$ANS" != "Y" ]]; then
  echo "Aborted."
  exit 1
fi

printf '\n==> Deleting Firestore docs via backend Python env\n'
cd backend
uv run python - "$EMAIL" <<'PY'
import sys
from google.cloud import firestore

email = sys.argv[1]
client = firestore.Client(project="bonsai-feed-filter")
col = client.collection("bonsai_posts")

matches = list(col.where("user_email", "==", email).stream())
print(f"   found {len(matches)} docs for {email}")

batch = client.batch()
batched = 0
for d in matches:
    batch.delete(d.reference)
    batched += 1
    if batched == 400:
        batch.commit()
        batch = client.batch()
        batched = 0
if batched:
    batch.commit()

print(f"   deleted {len(matches)} docs")
PY
cd - >/dev/null

printf '\n==> Backend done. Clear the extension local state next:\n'
cat <<'SNIPPET'

   1. Open chrome://extensions
   2. Click "service worker" under Bonsai to open DevTools
   3. Paste into the console:

      chrome.runtime.sendMessage({ type: "bonsai:resetAll" }, (r) => console.log(r))

   Expected response:  { ok: true }

   That clears bonsaiUser, bonsaiCaptures, bonsaiConfig, bonsaiOnboarded,
   bonsaiCoachSeen — everything in chrome.storage.local for this extension.
SNIPPET
