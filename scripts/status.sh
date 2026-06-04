#!/usr/bin/env bash
# One-screen terminal dashboard built from direct D1 queries (spec §10).
# Prints: ingestion freshness, review-queue depth, identity-resolution health,
# last cron success (newest cursor update), and recent proposal throughput.
#
# Usage: scripts/status.sh           (or `make status`)
# Env:   DB_NAME (default: crm), D1_FLAG (default: --remote; pass --local to inspect local)
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

DB_NAME="${DB_NAME:-crm}"
D1_FLAG="${D1_FLAG:---remote}"
WRANGLER="pnpm exec wrangler"

q() {
  # Run one D1 query and print results as a borderless table.
  ${WRANGLER} d1 execute "${DB_NAME}" "${D1_FLAG}" --command "$1" 2>/dev/null || {
    echo "  (query failed — is the DB created/migrated? try: make migrate)"
  }
}

hr() { printf '%*s\n' 64 '' | tr ' ' '-'; }

echo ""
echo "===================  CRM PIPELINE STATUS  ===================="
echo " db=${DB_NAME}  scope=${D1_FLAG}  at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
hr

echo "INGESTION FRESHNESS (newest message + total)"
q "SELECT datetime(MAX(msg_date),'unixepoch') AS newest_utc, \
         (strftime('%s','now') - MAX(msg_date)) AS age_seconds, \
         COUNT(*) AS total_messages \
   FROM telegram_messages;"
hr

echo "UN-EXTRACTED BACKLOG (messages awaiting the extract pipeline)"
q "SELECT COUNT(*) AS unextracted FROM telegram_messages WHERE extracted_at IS NULL;"
hr

echo "REVIEW QUEUE DEPTH (crm_proposals by status)"
q "SELECT status, COUNT(*) AS n FROM crm_proposals GROUP BY status ORDER BY status;"
hr

echo "IDENTITY RESOLUTION HEALTH (identity_map by status)"
q "SELECT status, COUNT(*) AS n FROM identity_map GROUP BY status ORDER BY status;"
hr

echo "CHAT CURSORS (most recently advanced — proxy for last cron success)"
q "SELECT chat_id, chat_title, last_message_id, datetime(updated_at,'unixepoch') AS updated_utc \
   FROM chat_cursors ORDER BY updated_at DESC LIMIT 5;"
hr

echo "PROPOSAL THROUGHPUT (created in last 24h)"
q "SELECT COUNT(*) AS created_24h FROM crm_proposals \
   WHERE created_at >= strftime('%s','now') - 86400;"
hr
echo "Logs:  make tail APP=ingest    Cron:  pnpm exec wrangler triggers"
echo "=============================================================="
echo ""
