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
  # Run one D1 query and print just the result rows, tidily. Newer wrangler wraps
  # output in ANSI codes + a verbose meta block on a merged stream, so we strip
  # ANSI, find the JSON array, and print only the rows. --config points wrangler
  # at the shared DB binding (there's no wrangler.jsonc at the repo root).
  ${WRANGLER} d1 execute "${DB_NAME}" "${D1_FLAG}" --config packages/db/wrangler.jsonc --command "$1" 2>&1 | python3 -c '
import sys, re, json
t = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", sys.stdin.read())
i = t.find("[")
if i < 0:
    print("  (query failed — is the DB created/migrated? try: make migrate)"); sys.exit()
try:
    rows = json.loads(t[i:])[0]["results"]
except Exception:
    print("  (could not parse wrangler output)"); sys.exit()
if not rows:
    print("  (no rows)")
for r in rows:
    print("  " + "   ".join(f"{k}={v}" for k, v in r.items()))
'
}

hr() { printf '%*s\n' 64 '' | tr ' ' '-'; }

echo ""
echo "===================  CRM PIPELINE STATUS  ===================="
echo " db=${DB_NAME}  scope=${D1_FLAG}  at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
hr

echo "LAST RUN PER COMPONENT (heartbeat — the real liveness signal)"
q "SELECT component, datetime(updated_at,'unixepoch') AS last_run_utc, \
         (strftime('%s','now') - updated_at) AS age_seconds, \
         ok, substr(detail,1,60) AS detail \
   FROM system_status ORDER BY component;"
hr

echo "INGESTION FRESHNESS (newest message + total — tracks Telegram traffic, not health)"
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

echo "CHAT CURSORS (most recently advanced — last message ACTIVITY, not run health)"
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
