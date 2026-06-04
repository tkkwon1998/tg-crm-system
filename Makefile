# Telegram -> Attio CRM enrichment — terminal-only operating model.
# Every deploy, migration, secret, and query runs through wrangler from the shell.
#
# Usage:
#   make bootstrap            # create D1, install deps, scaffold local config
#   make migrate              # apply D1 migrations (--remote)
#   make migrate-local        # apply D1 migrations to local .wrangler SQLite
#   make secrets              # print the `wrangler secret put` checklist
#   make deploy               # deploy every app in dependency order
#   make deploy APP=extract   # deploy a single app
#   make backfill DAYS=90     # one-shot history load via D1 REST API
#   make status               # one-screen D1 dashboard
#   make tail APP=ingest      # stream a Worker's logs

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# Logical D1 database name (matches `database_name` in each app's wrangler.jsonc).
DB_NAME ?= crm
# Apps in deploy / dependency order. db migrations run first (handled in deploy-all.sh).
APPS := ingest extract sync apply watchdog

.PHONY: help
help:
	@echo "Targets:"
	@echo "  bootstrap            create D1 db, install deps"
	@echo "  migrate              apply D1 migrations (--remote)"
	@echo "  migrate-local        apply D1 migrations (--local)"
	@echo "  secrets              print the wrangler secret put checklist"
	@echo "  deploy               deploy all apps in order (scripts/deploy-all.sh)"
	@echo "  deploy APP=<name>    deploy a single app"
	@echo "  backfill DAYS=<n>    one-shot history load (scripts/backfill.ts)"
	@echo "  status               D1 dashboard (scripts/status.sh)"
	@echo "  deals                list chat -> deal mappings (confirmed/candidate/unmatched)"
	@echo "  link-deal CHAT=.. DEAL=..   confirm a group chat -> Attio deal link"
	@echo "  tail APP=<name>      stream a Worker's logs"

.PHONY: bootstrap
bootstrap:
	pnpm install
	@echo ">> Creating D1 database '$(DB_NAME)' (idempotent — ignore 'already exists')."
	-pnpm exec wrangler d1 create $(DB_NAME)
	@echo ""
	@echo ">> Copy the database_id printed above into each apps/*/wrangler.jsonc (d1_databases[].database_id)."
	@echo ">> Then run: make migrate"

.PHONY: migrate
migrate:
	pnpm exec wrangler d1 migrations apply $(DB_NAME) --remote --config packages/db/wrangler.jsonc

.PHONY: migrate-local
migrate-local:
	pnpm exec wrangler d1 migrations apply $(DB_NAME) --local --config packages/db/wrangler.jsonc

.PHONY: secrets
secrets:
	@echo "Set these per-Worker from the shell. Secrets are scoped to each Worker,"
	@echo "so cd into the app dir (or pass --config apps/<app>/wrangler.jsonc):"
	@echo ""
	@echo "  ingest    : TG_API_ID TG_API_HASH TG_SESSION"
	@echo "  extract   : ANTHROPIC_API_KEY ATTIO_TOKEN"
	@echo "  sync      : NOTION_TOKEN"
	@echo "  apply     : ATTIO_TOKEN"
	@echo "  watchdog  : SLACK_WEBHOOK_URL HEALTHCHECK_URL"
	@echo ""
	@echo "  # TG_SESSION first: cd apps/ingest/container && python login.py"
	@echo "  cd apps/ingest    && pnpm exec wrangler secret put TG_API_ID"
	@echo "  cd apps/ingest    && pnpm exec wrangler secret put TG_API_HASH"
	@echo "  cd apps/ingest    && pnpm exec wrangler secret put TG_SESSION"
	@echo "  cd apps/extract   && pnpm exec wrangler secret put ANTHROPIC_API_KEY"
	@echo "  cd apps/extract   && pnpm exec wrangler secret put ATTIO_TOKEN"
	@echo "  cd apps/sync      && pnpm exec wrangler secret put NOTION_TOKEN"
	@echo "  cd apps/apply     && pnpm exec wrangler secret put ATTIO_TOKEN"
	@echo "  cd apps/watchdog  && pnpm exec wrangler secret put SLACK_WEBHOOK_URL"
	@echo "  cd apps/watchdog  && pnpm exec wrangler secret put HEALTHCHECK_URL"

.PHONY: deploy
deploy:
ifeq ($(strip $(APP)),)
	bash scripts/deploy-all.sh
else
	pnpm exec wrangler deploy --config apps/$(APP)/wrangler.jsonc
endif

.PHONY: backfill
backfill:
	@if [ -z "$(strip $(DAYS))" ]; then echo "Usage: make backfill DAYS=90"; exit 1; fi
	pnpm exec tsx scripts/backfill.ts --days $(DAYS)

.PHONY: status
status:
	bash scripts/status.sh

# Review the chat -> deal mappings (confirmed / candidate / unmatched).
.PHONY: deals
deals:
	pnpm exec wrangler d1 execute $(DB_NAME) --remote --config packages/db/wrangler.jsonc \
	  --command "SELECT chat_id, status, round(confidence,2) AS conf, substr(chat_title,1,32) AS chat, attio_deal_id AS deal FROM deal_map ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'unmatched' THEN 1 ELSE 2 END, updated_at DESC;"

# Confirm a group chat -> Attio deal link (hybrid model). Then sync reflects it.
#   make link-deal CHAT=-5214111798 DEAL=rec_abc123
.PHONY: link-deal
link-deal:
	@if [ -z "$(strip $(CHAT))" ] || [ -z "$(strip $(DEAL))" ]; then \
	  echo "Usage: make link-deal CHAT=<telegram_chat_id> DEAL=<attio_deal_id>"; exit 1; fi
	pnpm exec wrangler d1 execute $(DB_NAME) --remote --config packages/db/wrangler.jsonc \
	  --command "INSERT INTO deal_map (chat_id, attio_deal_id, status, confidence, match_method, updated_at) VALUES ($(CHAT), '$(DEAL)', 'confirmed', 1, 'manual', unixepoch()) ON CONFLICT(chat_id) DO UPDATE SET attio_deal_id=excluded.attio_deal_id, status='confirmed', confidence=1, match_method='manual', updated_at=excluded.updated_at;"
	@echo ">> Linked chat $(CHAT) -> deal $(DEAL) (confirmed). sync will reflect it on its next run."

.PHONY: tail
tail:
	@if [ -z "$(strip $(APP))" ]; then echo "Usage: make tail APP=ingest"; exit 1; fi
	pnpm exec wrangler tail --config apps/$(APP)/wrangler.jsonc --format pretty
