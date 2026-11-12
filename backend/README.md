# Bonsai backend

FastAPI ingest service backed by Supabase Postgres. Deployable to FastAPI Cloud.

## Local setup

```sh
cd backend
uv sync
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_OAUTH_CLIENT_ID
uv run uvicorn bonsai.main:app --reload --port 8000
```

## Database migration

Apply `supabase/migrations/0001_init.sql` via the Supabase SQL editor or the CLI:

```sh
supabase db push   # requires `supabase link` first
```

## Verification

```sh
uv run ruff check .
uv run ruff format --check .
uv run pyrefly check
uv run pytest
```

## Deploy (FastAPI Cloud)

```sh
fastapi deploy backend/bonsai/main.py
```

Set the three env vars in the FastAPI Cloud dashboard after the first deploy.
