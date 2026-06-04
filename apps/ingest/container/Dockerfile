# Telethon ingest fetcher (spec §5.1). Thin Python HTTP service on :8080.
# Built + pushed automatically by `wrangler deploy` (image ref in wrangler.jsonc).
FROM python:3.12-slim

# Telethon's crypto path benefits from a C extension; keep the image lean.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py

# Non-root for safety; the service binds an unprivileged port.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# Stdlib HTTP server; connects to Telegram per request and exits cleanly on sleep.
CMD ["python", "/app/main.py"]
