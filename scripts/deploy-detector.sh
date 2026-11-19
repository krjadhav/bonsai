#!/usr/bin/env bash
# Deploy the experimental Bonsai AI-content detector to Cloud Run.
#
# Flow:
#   1. Read HF_TOKEN from the repo root .env (gated HuggingFace repo).
#   2. Upsert the HF token into Secret Manager as `bonsai-hf-token`.
#   3. Grant the Cloud Run runtime SA read access to that secret.
#   4. Deploy `detector/` via `gcloud run deploy --source`.
#   5. Print the URL so it can be stamped into background.js DEFAULT_CONFIG.
#
# Idempotent. Safe to re-run after a code change.

set -euo pipefail

PROJECT_ID="bonsai-feed-filter"
REGION="asia-south1"
SERVICE="bonsai-detector"
SECRET_NAME="bonsai-hf-token"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "error: ${ENV_FILE} not found" >&2
  exit 1
fi

# shellcheck disable=SC2155
HF_TOKEN="$(grep -E '^HF_TOKEN=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
if [[ -z "${HF_TOKEN}" ]]; then
  echo "error: HF_TOKEN not set in ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC2155
MODEL_ID="$(grep -E '^AI_WRITING_DETECTION_MODEL_ID=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
if [[ -z "${MODEL_ID}" ]]; then
  echo "error: AI_WRITING_DETECTION_MODEL_ID not set in ${ENV_FILE}" >&2
  exit 1
fi

echo "==> enabling Secret Manager API"
gcloud services enable secretmanager.googleapis.com \
  --project="${PROJECT_ID}" --quiet

echo "==> upserting secret ${SECRET_NAME}"
if ! gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets create "${SECRET_NAME}" \
    --replication-policy=automatic \
    --project="${PROJECT_ID}" --quiet
fi
printf '%s' "${HF_TOKEN}" | gcloud secrets versions add "${SECRET_NAME}" \
  --data-file=- --project="${PROJECT_ID}" --quiet

echo "==> granting Cloud Run SA access to ${SECRET_NAME}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${PROJECT_ID}" --quiet >/dev/null

echo "==> deploying ${SERVICE} from detector/"
cd "${ROOT_DIR}/detector"
gcloud run deploy "${SERVICE}" \
  --source=. \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --allow-unauthenticated \
  --no-invoker-iam-check \
  --min-instances=0 \
  --max-instances=2 \
  --cpu=2 \
  --memory=4Gi \
  --timeout=300 \
  --concurrency=4 \
  --set-env-vars="ALLOWED_ORIGINS=,AI_WRITING_DETECTION_MODEL_ID=${MODEL_ID}" \
  --set-secrets="HF_TOKEN=${SECRET_NAME}:latest" \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value(status.url)')"

echo ""
echo "==> deployed: ${URL}"
echo ""
echo "Next steps:"
echo "  1. Stamp the URL into extension/background.js DEFAULT_CONFIG.detectorBaseUrl:"
echo "       \"${URL}\""
echo "  2. Reload the extension and flip the popup toggle to try it."
echo ""
echo "Smoke test:"
echo "  curl -s ${URL}/health | jq ."
echo "  curl -s -X POST ${URL}/detect -H 'content-type: application/json' \\"
echo "    -d '{\"items\":[{\"post_id\":\"1\",\"text\":\"Hello world\"}]}' | jq ."
