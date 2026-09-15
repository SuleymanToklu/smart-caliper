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

COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY smart_caliper/ smart_caliper/
COPY samples/ samples/

EXPOSE 8000

ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "smart_caliper.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
