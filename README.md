# Telegram → Attio CRM Enrichment

Cloudflare-native monorepo that continuously ingests Telegram messages, resolves
each sender to an Attio record, proposes structured CRM updates with Claude, and
surfaces a human-reviewable "who to bump" layer in Notion.

**Operating model: terminal-only.** Every deploy, migration, secret, query, and
log stream runs through `wrangler` from the shell. No web dashboards in the loop
(the one unavoidable exception is the initial `wrangler login` / account setup).

## Layout

```
packages/db/        # @crm/db — canonical D1 schema, migrations, typed client + shared types (the contract)
apps/ingest/        # Worker (cron */1) + Telethon container — catch-up fetch, write to D1
apps/extract/       # Worker/Workflow — identity resolution + Claude extraction -> crm_proposals
apps/sync/          # Worker (cron) — project state into the Notion action database
apps/apply/         # Worker — approved proposals -> Attio (assert + provenance note)
apps/watchdog/      # Worker (cron */5) — freshness + queue-depth checks -> Slack + healthcheck
scripts/            # deploy-all.sh, status.sh, backfill.ts
```

The shared `@crm/db` package owns the schema and is the single source of truth
for table shapes and TypeScript types. All five apps import from it.

## Architecture (data flow)

```
cron */1 ─► ingest Worker ─► ingest Container (Telethon) ─► Telegram (MTProto, read-only)
                │ writes raw messages + advances cursors
                ▼
              D1 (crm): telegram_messages, chat_cursors, identity_map, crm_proposals
                ▲                          │
   extract Worker/Workflow ────────────────┘ resolve identity -> Claude -> crm_proposals
                │
   sync Worker ─┴─► Notion action DB   apply Worker ─► Attio (assert_person + create_note)
   watchdog (cron */5) ─► Slack alert + healthcheck dead-man's-switch ping
```

## Prerequisites

- Node ≥ 22, `pnpm` (`corepack enable`)
- `wrangler` (installed as a dev dependency; run via `pnpm exec wrangler` or the Makefile)
- A Cloudflare account; one-time `wrangler login`
- Docker (only for building/running the ingest container and `make backfill`)

## Quick start

```bash
make bootstrap            # pnpm install + wrangler d1 create crm
# copy the printed database_id into each apps/*/wrangler.jsonc
make migrate              # apply D1 migrations --remote
make secrets              # prints the wrangler secret put checklist; set each one
make deploy               # deploy db migrations, then ingest, extract, sync, apply, watchdog
```

## Operating the system

```bash
make deploy APP=extract   # redeploy a single app
make backfill DAYS=90     # one-shot history load via the D1 REST API (runs locally, not on cron)
make status               # one-screen D1 dashboard (freshness, queue depth, identity health)
make tail APP=ingest      # stream a Worker's logs
```

Direct monitoring (spec §10):

```bash
wrangler d1 execute crm --remote --command \
  "SELECT MAX(msg_date) AS newest, COUNT(*) AS total FROM telegram_messages;"
wrangler d1 execute crm --remote --command \
  "SELECT status, COUNT(*) FROM crm_proposals GROUP BY status;"
wrangler deployments list --name ingest
wrangler triggers
```

## Secrets (spec §8)

Set per-Worker from the shell; never committed. `.dev.vars.example` is the local
template — copy to `.dev.vars` (git-ignored) for `wrangler dev`.

| Secret | Used by |
|---|---|
| `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` | ingest |
| `ANTHROPIC_API_KEY` | extract |
| `ATTIO_TOKEN` | extract, apply |
| `NOTION_TOKEN` | sync |
| `SLACK_WEBHOOK_URL`, `HEALTHCHECK_URL` | watchdog |

## Local development

```bash
make migrate-local                          # seed local D1 (.wrangler SQLite)
pnpm exec wrangler dev --config apps/<app>/wrangler.jsonc
```

## Security notes

- `TG_SESSION` is account-level Telegram access — store only as a Worker secret, rotate if leaked, keep ingestion read-only.
- You persist counterparty PII; decide D1 retention and access up front.
- Every applied CRM write carries a provenance note citing source `chat_id:message_id`.
- Idempotency end-to-end: `(chat_id, message_id)` PK + proposal `status` transitions make cron re-runs safe.
