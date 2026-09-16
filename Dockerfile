# Multi-stage lightweight build for SmartCaliper
FROM python:3.11-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY smart_caliper/ smart_caliper/

RUN pip install --no-cache-dir .

FROM python:3.11-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
# Create non-root user (UID 1000 for Hugging Face Spaces / Rootless container standard)
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app/results /app/samples && \
    chown -R appuser:appuser /app

COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --chown=appuser:appuser smart_caliper/ smart_caliper/
COPY --chown=appuser:appuser samples/ samples/

USER appuser

ENV PYTHONUNBUFFERED=1 \
    PORT=8000

# Support both standard local port (8000) and Hugging Face Spaces default (7860)
EXPOSE 8000 7860

CMD ["sh", "-c", "uvicorn smart_caliper.api.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
