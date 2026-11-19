# Cloud Run container for the Bonsai detector service.
#
# Model (~1.4 GB) is downloaded on first request rather than baked into the
# image. Keeps the image small at the cost of a cold-start penalty the first
# time each instance serves traffic. Experimental-only — fine.
#
# Torch is installed from the CPU index to avoid CUDA wheels we'd never use.

FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN python -m venv /app/.venv \
 && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
 && /app/.venv/bin/pip install --no-cache-dir \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -r requirements.txt

COPY bonsai_detector ./bonsai_detector


FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    PATH="/app/.venv/bin:$PATH" \
    HF_HOME=/tmp/huggingface \
    TRANSFORMERS_CACHE=/tmp/huggingface

RUN groupadd --system app && useradd --system --gid app --home-dir /app app
WORKDIR /app

COPY --from=builder --chown=app:app /app /app

USER app

# Single worker. Cloud Run handles concurrency; torch inference is CPU-bound
# per request and benefits from a warm Python process.
CMD ["sh", "-c", "exec uvicorn bonsai_detector.main:app --host 0.0.0.0 --port ${PORT}"]
