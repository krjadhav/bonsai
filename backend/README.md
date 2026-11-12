# Bonsai backend

FastAPI ingest service for Bonsai. Deployed on **Google Cloud Run** backed by
**Firestore (native mode)**. Scales to zero; Firestore's daily free tier
covers hobby usage.

## Architecture

```
Chrome extension  --Bearer <google oauth token>-->  Cloud Run (bonsai-api)
                                                        |
                                                verify token via
                                                  tokeninfo endpoint
                                                        |
                                                Firestore (bonsai_posts)
```

- Collection `bonsai_posts`, document id `{user_sub}_{post_id}` → natural dedup.
- No RLS/IAM gymnastics: Cloud Run SA holds `roles/datastore.user`, auth of the
  end user is enforced at the edge by the FastAPI handler.

## One-time Google Cloud setup

> All commands scope explicitly to `--project=bonsai-feed-filter`, use
> `--quiet` for non-interactive execution, and follow the gcloud agent skill
> conventions. Run them from your shell.

### 1. Enable required APIs (user action — billing-sensitive)

```sh
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  --project=bonsai-feed-filter --quiet
```

### 2. Create the Firestore database (native mode, one-time per project)

Pick a region close to you. `us-central1` has the broadest free-tier coverage.

```sh
gcloud firestore databases create \
  --location=us-central1 \
  --type=firestore-native \
  --project=bonsai-feed-filter --quiet
```

### 3. Create an Artifact Registry repo for the container image

```sh
gcloud artifacts repositories create bonsai \
  --repository-format=docker \
  --location=us-central1 \
  --description="Bonsai backend images" \
  --project=bonsai-feed-filter --quiet
```

### 4. Grant Firestore access to the Cloud Run runtime service account

Cloud Run uses the Compute Engine default service account unless you specify
another one. Grant it `roles/datastore.user`:

```sh
PROJECT_NUMBER=$(gcloud projects describe bonsai-feed-filter \
  --format='value(projectNumber)')
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding bonsai-feed-filter \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/datastore.user" \
  --condition=None \
  --quiet
```

### 5. Local Application Default Credentials (for `uv run` locally)

```sh
gcloud auth application-default login
gcloud auth application-default set-quota-project bonsai-feed-filter
```

## Local development

```sh
cd backend
uv sync
cp .env.example .env     # fill in GOOGLE_OAUTH_CLIENT_ID and ALLOWED_ORIGINS
uv run uvicorn bonsai.main:app --reload --port 8000
# smoke test
curl -s http://localhost:8000/health
```

## Verification (CI-style)

```sh
uv run ruff check .
uv run ruff format --check .
uv run pyrefly check
uv run pytest
```

## Deploy to Cloud Run

Simplest path — `gcloud run deploy --source .` auto-builds via Cloud Build
using the local Dockerfile and pushes to Artifact Registry.

```sh
gcloud run deploy bonsai-api \
  --source=. \
  --region=us-central1 \
  --project=bonsai-feed-filter \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=5 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=30 \
  --set-env-vars="GCP_PROJECT_ID=bonsai-feed-filter,FIRESTORE_COLLECTION=bonsai_posts,GOOGLE_OAUTH_CLIENT_ID=REPLACE_ME.apps.googleusercontent.com,ALLOWED_ORIGINS=chrome-extension://REPLACE_WITH_EXTENSION_ID" \
  --quiet
```

**Why these flags:**

- `--allow-unauthenticated`: end users carry Google OAuth bearer tokens; the
  app verifies them. Cloud Run invoker IAM is intentionally off so the extension
  can call it without a GCP identity.
- `--min-instances=0`: scale to zero. No idle billing.
- `--max-instances=5`: hard cap guards against runaway cost from a looped bug.
- `--memory=512Mi --cpu=1`: fits Firestore SDK + Pydantic comfortably with
  room to spare; smaller shapes OOM on first cold start.
- `--timeout=30`: single POST ingest; never long-running.

After the first deploy copy the service URL that `gcloud` prints — point the
extension's `apiBaseUrl` at it (see root README / background.js setConfig).

### Rotating config without a redeploy

```sh
gcloud run services update bonsai-api \
  --region=us-central1 \
  --project=bonsai-feed-filter \
  --update-env-vars="ALLOWED_ORIGINS=chrome-extension://NEW_ID" \
  --quiet
```

## Firestore free tier (why this stays at $0)

Daily free quota per project:

- 50,000 document reads
- 20,000 document writes
- 20,000 document deletes
- 1 GiB storage

Each tweet seen is **one write** (merge upsert). 20k posts/day = free. Sidebar
and sync never read Firestore back from the server, so reads stay near zero.

## Tech choices rejected (for the record)

- **Cloud SQL Postgres**: ~$10/mo floor (no scale-to-zero on relational tiers).
  Fine schema, but violates the pricing-conscious requirement.
- **AlloyDB**: overkill, expensive.
- **Compute Engine + self-hosted Postgres**: free tier VM available, but ops
  burden (patching, backups, failover) isn't worth it.
