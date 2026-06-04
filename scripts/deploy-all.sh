#!/usr/bin/env bash
# Deploy the whole system in dependency order, terminal-only.
#   1. D1 migrations (the schema every app depends on)
#   2. ingest  (Worker + Telethon container — image is built/pushed by wrangler deploy)
#   3. extract
#   4. sync
#   5. apply
#   6. watchdog
#
# Usage: scripts/deploy-all.sh        (or `make deploy`)
# Env:   DB_NAME (default: crm), REMOTE (default: --remote for migrations)
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

DB_NAME="${DB_NAME:-crm}"
APPS=(ingest extract sync apply watchdog)
WRANGLER="pnpm exec wrangler"

echo "==> [1/6] Applying D1 migrations for '${DB_NAME}' (--remote)"
${WRANGLER} d1 migrations apply "${DB_NAME}" --remote

i=1
for app in "${APPS[@]}"; do
  i=$((i + 1))
  cfg="apps/${app}/wrangler.jsonc"
  if [[ ! -f "${cfg}" ]]; then
    echo "==> [${i}/6] SKIP ${app} — ${cfg} not found yet"
    continue
  fi
  echo "==> [${i}/6] Deploying ${app} (${cfg})"
  ${WRANGLER} deploy --config "${cfg}"
done

echo "==> Done. Confirm cron schedules with: pnpm exec wrangler triggers"
