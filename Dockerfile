## ── Stage 1: build dependencies with uv ─────────────────────────────────────
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

WORKDIR /app

# Copy lockfile + manifest first for better layer caching
COPY pyproject.toml uv.lock ./

# Install dependencies into the system environment (no venv, no dev deps)
ENV UV_NO_DEV=1
ENV UV_PROJECT_ENVIRONMENT=/usr/local
RUN uv sync --locked --no-install-project

## ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code
COPY scripts/mqtt2hf_dlt.py /app/mqtt2hf_dlt.py
COPY .dlt/ /app/.dlt/

CMD ["python", "-u", "/app/mqtt2hf_dlt.py"]
