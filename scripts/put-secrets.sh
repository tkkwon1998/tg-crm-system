#!/usr/bin/env bash
# Interactive secret loader (spec §8). Runs `wrangler secret put` for every
# Worker secret, in order, so you paste each value at the prompt exactly once.
#
# Secret values go straight from your terminal into Cloudflare's encrypted
# secret store — they are never written to a file, logged, or echoed.
#
# Usage:
#   bash scripts/put-secrets.sh             # all apps, all secrets
#   bash scripts/put-secrets.sh ingest      # just one app's secrets
#
# Prereqs:
#   - `pnpm exec wrangler login` (one-time)
#   - each app deployed at least once (`make deploy`) so the Worker exists;
#     if you see "workers script ... not found", deploy that app first.
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="pnpm exec wrangler"

# app -> space-separated secret names (mirrors `make secrets`)
secrets_for() {
  case "$1" in
    ingest)   echo "TG_API_ID TG_API_HASH TG_SESSION" ;;
    extract)  echo "ANTHROPIC_API_KEY ATTIO_TOKEN" ;;
    sync)     echo "NOTION_TOKEN" ;;
    apply)    echo "ATTIO_TOKEN" ;;
    watchdog) echo "SLACK_WEBHOOK_URL HEALTHCHECK_URL" ;;
    *) echo "" ;;
  esac
}

APPS=("ingest" "extract" "sync" "apply" "watchdog")
if [[ $# -gt 0 ]]; then APPS=("$@"); fi

for app in "${APPS[@]}"; do
  cfg="apps/${app}/wrangler.jsonc"
  names="$(secrets_for "$app")"
  if [[ -z "$names" ]]; then
    echo "!! unknown app '$app' (skipping)"; continue
  fi
  if [[ ! -f "$cfg" ]]; then
    echo "!! $cfg not found (skipping $app)"; continue
  fi
  echo ""
  echo "=================================================================="
  echo ">> $app  ($cfg)"
  echo "=================================================================="
  for name in $names; do
    echo ""
    read -r -p "Set secret '$name' for '$app'? [Y/n/skip-app] " ans
    case "${ans:-y}" in
      n|N)            echo "   skipped $name" ;;
      skip-app|s|S)   echo "   skipping rest of $app"; break ;;
      *)              $WRANGLER secret put "$name" --config "$cfg" ;;
    esac
  done
done

echo ""
echo ">> Done. Verify per app with:  pnpm exec wrangler secret list --config apps/<app>/wrangler.jsonc"
