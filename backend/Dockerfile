# Cloud Run container for the Bonsai ingest API.
#
# Best practices followed:
#   * Slim Debian-based Python image (predictable glibc, small surface area).
#   * `uv` installs dependencies into a system site-packages via pyproject.toml
#     so the final image has no build toolchain.
#   * Non-root runtime user.
#   * Listens on $PORT (Cloud Run injects this).
#   * Single uvicorn worker (Cloud Run manages concurrency, not Python).

FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.6.3 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY bonsai ./bonsai
RUN uv sync --frozen --no-dev


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    PATH="/app/.venv/bin:$PATH"

RUN groupadd --system app && useradd --system --gid app --home-dir /app app
WORKDIR /app

COPY --from=builder --chown=app:app /app /app

USER app

# Cloud Run sends SIGTERM; uvicorn handles it and drains in-flight requests.
CMD ["sh", "-c", "exec uvicorn bonsai.main:app --host 0.0.0.0 --port ${PORT}"]
