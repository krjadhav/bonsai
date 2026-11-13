#!/usr/bin/env bash
# Verify the existing bonsai-api Cloud Run + Firestore stack and wire
# ALLOWED_ORIGINS to the given extension id. Does NOT create APIs, SAs,
# Firestore databases, Artifact Registry repos, or Cloud Run services —
# that infra already exists. See backend/README.md for one-time bring-up.
#
# Prerequisites:
#   * gcloud CLI installed and logged in (`gcloud auth login`).
#
# Usage:
#   ./scripts/gcloud-setup.sh <extension-id> [oauth-client-id]
#
# <extension-id>   32 lowercase [a-p] characters, from chrome://extensions.
# [oauth-client-id] optional; omit to leave the existing env var intact.

set -euo pipefail

EXT_ID="${1:-}"
OAUTH_CLIENT_ID="${2:-}"

if [[ -z "$EXT_ID" ]]; then
  echo "usage: $0 <extension-id> [oauth-client-id]"
  exit 1
fi

if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "error: extension id must be 32 chars in [a-p]"
  exit 1
fi

PROJECT="bonsai-feed-filter"
REGION="us-central1"
SERVICE="bonsai-api"
ORIGIN="chrome-extension://${EXT_ID}"

say() { printf '\n==> %s\n' "$*"; }

say "Checking gcloud auth"
if ! gcloud auth print-access-token --quiet >/dev/null 2>&1; then
  echo "error: gcloud is not authenticated. Run: gcloud auth login"
  exit 1
fi
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
echo "   account: ${ACCOUNT}"
echo "   project: ${PROJECT}"

say "Verifying Firestore (default) database exists"
if ! gcloud firestore databases describe --database="(default)" \
     --project="${PROJECT}" --quiet >/dev/null 2>&1; then
  echo "error: Firestore (default) database missing in ${PROJECT}."
  echo "       Create it per backend/README.md before running this script."
  exit 1
fi
echo "   ok"

say "Verifying Cloud Run service ${SERVICE} exists"
if ! gcloud run services describe "${SERVICE}" \
     --region="${REGION}" --project="${PROJECT}" --quiet >/dev/null 2>&1; then
  echo "error: Cloud Run service ${SERVICE} missing in ${REGION}/${PROJECT}."
  echo "       Deploy it per backend/README.md before running this script."
  exit 1
fi

SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --project="${PROJECT}" \
  --format='value(status.url)')"
CURRENT_ORIGINS="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --project="${PROJECT}" \
  --format='value(spec.template.spec.containers[0].env[?(@.name=="ALLOWED_ORIGINS")].value)' \
  2>/dev/null || true)"
echo "   service URL:       ${SERVICE_URL}"
echo "   current ALLOWED_ORIGINS: ${CURRENT_ORIGINS:-<unset>}"

if [[ "${CURRENT_ORIGINS}" == *"${ORIGIN}"* ]]; then
  say "ALLOWED_ORIGINS already contains ${ORIGIN} — nothing to update"
else
  NEW_ORIGINS="${ORIGIN}"
  if [[ -n "${CURRENT_ORIGINS}" ]]; then
    NEW_ORIGINS="${ORIGIN},${CURRENT_ORIGINS}"
  fi
  say "Updating ALLOWED_ORIGINS → ${NEW_ORIGINS}"
  UPDATE_VARS="ALLOWED_ORIGINS=${NEW_ORIGINS}"
  if [[ -n "${OAUTH_CLIENT_ID}" ]]; then
    UPDATE_VARS="${UPDATE_VARS},GOOGLE_OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID}"
  fi
  gcloud run services update "${SERVICE}" \
    --region="${REGION}" --project="${PROJECT}" \
    --update-env-vars="${UPDATE_VARS}" \
    --quiet
fi

say "Health check"
if curl -fsS --max-time 10 "${SERVICE_URL}/health" >/dev/null; then
  echo "   ${SERVICE_URL}/health → 200"
else
  echo "   WARN: ${SERVICE_URL}/health did not return 200"
fi

say "Done. Point the extension at this URL from the service-worker console:"
echo "   chrome.runtime.sendMessage({ type: \"bonsai:setConfig\", payload: { apiBaseUrl: \"${SERVICE_URL}\" } })"
