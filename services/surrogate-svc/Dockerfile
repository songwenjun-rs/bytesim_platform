# syntax=docker/dockerfile:1.7
# Build context = repo root (see docker-compose.yml). RFC-001 v2 makes the
# image depend on shared/engine_contracts + shared/engine_runtime, both of
# which live outside services/surrogate-svc/, so the context must be wider.
FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /build
COPY services/surrogate-svc/requirements.lock ./
RUN pip install -r requirements.lock

FROM python:3.12-slim AS runtime
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/bytesim/shared
RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --no-create-home app
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY --chown=app:app services/surrogate-svc/app ./app
COPY --chown=app:app shared /opt/bytesim/shared
USER app
EXPOSE 8083
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8083/healthz', timeout=2).getcode()==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8083"]
