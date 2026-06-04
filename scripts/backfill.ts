/**
 * scripts/backfill.ts — one-shot Telegram history loader (spec §9).
 *
 *   make backfill DAYS=90      # -> pnpm exec tsx scripts/backfill.ts --days 90
 *
 * Why this is separate from the cron path: a large history pull would blow past
 * the 3-minute Worker->Container proxy timeout. So we run the SAME container
 * image locally via Docker (the thin Telethon fetcher in apps/ingest/container/)
 * and write the results straight to D1 through the D1 REST query API — never
 * touching the Worker. The fetch contract is byte-for-byte the one the Worker
 * uses (POST /fetch), and the SQL mirrors @crm/db's upsertMessages / setCursor
 * so backfilled rows are indistinguishable from cron-ingested ones (idempotent
 * on (chat_id, message_id); cursors only move forward).
 *
 * Required env (from your shell or apps/ingest/.dev.vars + Cloudflare creds):
 *   TG_API_ID, TG_API_HASH, TG_SESSION   — Telegram account credentials
 *   CLOUDFLARE_ACCOUNT_ID                — Cloudflare account id
 *   CLOUDFLARE_API_TOKEN                 — token with D1 edit permission
 *   D1_DATABASE_ID                       — the "crm" database id (from `make bootstrap`)
 * Optional:
 *   DB_NAME (default "crm"), IMAGE (default "crm-ingest:backfill"),
 *   FETCH_LIMIT_PER_CHAT (default 1000), MAX_CHATS (default 0 = no cap),
 *   CONTAINER_PORT (default 8080)
 *
 * Usage:
 *   tsx scripts/backfill.ts --days 90
 *   tsx scripts/backfill.ts --days 30 --chat -1001234567890   (repeatable)
 *   tsx scripts/backfill.ts --days 90 --no-build               (reuse local image)
 */

import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// types (mirror apps/ingest/src/worker.ts <-> container/main.py)
// ---------------------------------------------------------------------------

interface ContainerMessage {
  chat_id: number;
  message_id: number;
  sender_user_id: number | null;
  chat_title: string | null;
  text: string | null;
  msg_date: number;
  is_outgoing: boolean;
  raw_json: Record<string, unknown>;
}

interface AdvancedCursor {
  chat_id: number;
  last_message_id: number;
  chat_title: string | null;
}

interface FetchResponse {
  messages: ContainerMessage[];
  cursors: AdvancedCursor[];
  errors?: Array<{ chat_id: number | null; error: string }>;
}

// ---------------------------------------------------------------------------
// args + env
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  let days = 0;
  let build = true;
  const chats: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') days = parseInt(argv[++i] ?? '', 10);
    else if (a === '--chat') chats.push(parseInt(argv[++i] ?? '', 10));
    else if (a === '--no-build') build = false;
  }
  return { days, build, chats };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`backfill: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTAINER_DIR = resolve(__dirname, '../apps/ingest/container');

// ---------------------------------------------------------------------------
// docker: build + run the container, talk to its /fetch endpoint
// ---------------------------------------------------------------------------

function buildImage(image: string): void {
  console.log(`backfill: building image ${image} from ${CONTAINER_DIR}`);
  execFileSync('docker', ['build', '-t', image, CONTAINER_DIR], { stdio: 'inherit' });
}

interface RunningContainer {
  id: string;
  baseUrl: string;
}

function startContainer(
  image: string,
  port: number,
  creds: { apiId: string; apiHash: string; session: string }
): RunningContainer {
  // Detached; we tear it down in finally. Host port is mapped to the container's.
  const out = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-p',
      `${port}:8080`,
      '-e',
      `TG_API_ID=${creds.apiId}`,
      '-e',
      `TG_API_HASH=${creds.apiHash}`,
      '-e',
      `TG_SESSION=${creds.session}`,
      image,
    ],
    { encoding: 'utf-8' }
  );
  const id = out.trim();
  return { id, baseUrl: `http://127.0.0.1:${port}` };
}

function stopContainer(id: string): void {
  try {
    execFileSync('docker', ['stop', id], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

async function waitHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('backfill: container did not become healthy in time');
}

// ---------------------------------------------------------------------------
// D1 REST query API
// ---------------------------------------------------------------------------

interface D1Client {
  query(sql: string, params: unknown[]): Promise<void>;
}

function makeD1Client(accountId: string, databaseId: string, token: string): D1Client {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return {
    async query(sql, params) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });
      const body = (await res.json()) as {
        success: boolean;
        errors?: Array<{ message: string }>;
      };
      if (!res.ok || !body.success) {
        const msg = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
        throw new Error(`D1 query failed: ${msg}`);
      }
    },
  };
}

// SQL mirrors @crm/db upsertMessages (idempotent on PK) and setCursor (MAX guard).
const UPSERT_MESSAGE_SQL = `INSERT INTO telegram_messages
   (chat_id, message_id, sender_user_id, chat_title, text, msg_date, is_outgoing, raw_json, ingested_at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
 ON CONFLICT (chat_id, message_id) DO UPDATE SET
   sender_user_id = excluded.sender_user_id,
   chat_title     = excluded.chat_title,
   text           = excluded.text,
   msg_date       = excluded.msg_date,
   is_outgoing    = excluded.is_outgoing,
   raw_json       = excluded.raw_json`;

const SET_CURSOR_SQL = `INSERT INTO chat_cursors (chat_id, last_message_id, chat_title, updated_at)
 VALUES (?1, ?2, ?3, ?4)
 ON CONFLICT (chat_id) DO UPDATE SET
   last_message_id = MAX(chat_cursors.last_message_id, excluded.last_message_id),
   chat_title      = COALESCE(excluded.chat_title, chat_cursors.chat_title),
   updated_at      = excluded.updated_at`;

const nowUnix = (): number => Math.floor(Date.now() / 1000);

async function writeMessages(d1: D1Client, msgs: ContainerMessage[]): Promise<number> {
  const ts = nowUnix();
  let written = 0;
  for (const m of msgs) {
    await d1.query(UPSERT_MESSAGE_SQL, [
      m.chat_id,
      m.message_id,
      m.sender_user_id ?? null,
      m.chat_title ?? null,
      m.text ?? null,
      m.msg_date,
      m.is_outgoing ? 1 : 0,
      JSON.stringify(m.raw_json ?? null),
      ts,
    ]);
    written++;
  }
  return written;
}

async function writeCursors(d1: D1Client, cursors: AdvancedCursor[]): Promise<number> {
  const ts = nowUnix();
  let advanced = 0;
  for (const c of cursors) {
    if (c.last_message_id > 0) {
      await d1.query(SET_CURSOR_SQL, [c.chat_id, c.last_message_id, c.chat_title ?? null, ts]);
      advanced++;
    }
  }
  return advanced;
}

// For backfill we want a time floor (DAYS) rather than the per-chat cursor.
// The container fetches id > min_id; for history we pass min_id = 0 and filter
// the returned messages by msg_date >= cutoff here. (The container is a generic
// fetcher; the date policy lives in the caller.)
function filterByCutoff(msgs: ContainerMessage[], cutoff: number): ContainerMessage[] {
  return msgs.filter((m) => m.msg_date >= cutoff);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { days, build, chats } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(days) || days <= 0) {
    console.error('Usage: tsx scripts/backfill.ts --days <N> [--chat <id> ...] [--no-build]');
    process.exit(1);
  }

  const creds = {
    apiId: requireEnv('TG_API_ID'),
    apiHash: requireEnv('TG_API_HASH'),
    session: requireEnv('TG_SESSION'),
  };
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = requireEnv('CLOUDFLARE_API_TOKEN');
  const databaseId = requireEnv('D1_DATABASE_ID');

  const image = process.env.IMAGE || 'crm-ingest:backfill';
  const port = parseInt(process.env.CONTAINER_PORT || '8080', 10);
  const fetchLimit = parseInt(process.env.FETCH_LIMIT_PER_CHAT || '1000', 10);
  const maxChats = parseInt(process.env.MAX_CHATS || '0', 10);

  const cutoff = nowUnix() - days * 86_400;
  const d1 = makeD1Client(accountId, databaseId, apiToken);

  if (build) buildImage(image);

  const container = startContainer(image, port, creds);
  console.log(`backfill: started container ${container.id.slice(0, 12)} on ${container.baseUrl}`);

  let totalMessages = 0;
  let totalCursors = 0;
  try {
    await waitHealthy(container.baseUrl);

    // History pull: min_id = 0 so the container walks back as far as the
    // fetch limit allows; we apply the DAYS cutoff client-side. If specific
    // --chat ids are given we seed cursors for exactly those; otherwise the
    // container discovers dialogs itself.
    const cursors =
      chats.length > 0
        ? chats.map((chat_id) => ({ chat_id, min_id: 0, chat_title: null }))
        : [];

    const reqBody = {
      cursors,
      fetch_limit_per_chat: fetchLimit,
      max_chats: maxChats,
    };

    console.log(
      `backfill: fetching history (days=${days}, cutoff=${cutoff}, limit/chat=${fetchLimit})`
    );
    const res = await fetch(`${container.baseUrl}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`container /fetch failed: HTTP ${res.status} ${detail.slice(0, 500)}`);
    }
    const payload = (await res.json()) as FetchResponse;

    for (const e of payload.errors ?? []) {
      console.warn(`backfill: container chat error chat_id=${e.chat_id ?? 'n/a'}: ${e.error}`);
    }

    const kept = filterByCutoff(payload.messages ?? [], cutoff);
    console.log(
      `backfill: container returned ${payload.messages?.length ?? 0} message(s); ${kept.length} within ${days}d window`
    );

    totalMessages = await writeMessages(d1, kept);

    // Advance cursors to the max id we actually persisted per chat so the cron
    // path resumes from the right place (never moves a cursor backward).
    const maxByChat = new Map<number, AdvancedCursor>();
    for (const m of kept) {
      const cur = maxByChat.get(m.chat_id);
      if (!cur || m.message_id > cur.last_message_id) {
        maxByChat.set(m.chat_id, {
          chat_id: m.chat_id,
          last_message_id: m.message_id,
          chat_title: m.chat_title,
        });
      }
    }
    totalCursors = await writeCursors(d1, [...maxByChat.values()]);
  } finally {
    stopContainer(container.id);
  }

  console.log(
    `backfill: done. wrote ${totalMessages} message(s), advanced ${totalCursors} cursor(s).`
  );
}

// Surface a clean error and a non-zero exit for the Makefile.
main().catch((err) => {
  console.error(`backfill: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
