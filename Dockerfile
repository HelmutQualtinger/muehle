# syntax=docker/dockerfile:1

# ---- builder: resolve deps with uv into a venv, no compiler toolchain kept --
FROM python:3.12-alpine AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

COPY app.py game.py ai.py ./
COPY templates ./templates
COPY static ./static

# ---- runtime: bare alpine + python, nothing else --------------------------
FROM python:3.12-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"

USER app
EXPOSE 5003

# One worker: NET_GAMES and the per-process session secret are in-memory,
# so multiple worker processes would fragment game/session state.
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:5003", "app:app"]
