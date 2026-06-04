/**
 * ingest Worker (spec §5.1)
 *
 * scheduled() handler, cron "* * * * *":
 *   1. read all chat cursors from D1
 *   2. invoke the bound Telethon container, passing the cursor map + TG creds
 *   3. receive new messages + advanced cursors
 *   4. write messages to D1 (idempotent on (chat_id, message_id))
 *   5. advance cursors per chat (setCursor is monotonic — MAX guard in @crm/db)
 *
 * The Worker holds the D1 binding; the container has NO database access — it is
 * a thin Telegram fetcher (it returns JSON and exits). Each run is bounded so it
 * stays well under the 3-minute Worker->Container proxy timeout.
 */

import { Container, getContainer } from '@cloudflare/containers';
import {
  getCursors,
  setCursor,
  upsertMessages,
  type ChatCursor,
  type MessageInput,
} from '@crm/db';

// ---------------------------------------------------------------------------
// Container Durable Object (backs the INGEST_CONTAINER binding)
// ---------------------------------------------------------------------------

/**
 * The Telethon image listens on port 8080 and exposes POST /fetch.
 * TG_API_ID / TG_API_HASH / TG_SESSION are injected into the container env from
 * the Worker secrets of the same name (account-level credentials, spec §5.1).
 */
export class IngestContainer extends Container<Env> {
  defaultPort = 8080;
  // Telegram connect + catch-up is seconds in steady state; give it headroom
  // but keep it well under the proxy timeout. The container exits on idle.
  sleepAfter = '2m';

  // Forward the account credentials from Worker secrets into the container env.
  // envVars is read at container start; the Worker sets these before invoking.
  envVars = {
    TG_API_ID: this.env.TG_API_ID ?? '',
    TG_API_HASH: this.env.TG_API_HASH ?? '',
    TG_SESSION: this.env.TG_SESSION ?? '',
  };
}

// ---------------------------------------------------------------------------
// Worker bindings
// ---------------------------------------------------------------------------

interface Env {
  DB: D1Database;
  INGEST_CONTAINER: DurableObjectNamespace<IngestContainer>;

  // Secrets (wrangler secret put) — forwarded into the container env.
  TG_API_ID: string;
  TG_API_HASH: string;
  TG_SESSION: string;

  // Non-secret tuning vars (wrangler.jsonc "vars").
  FETCH_LIMIT_PER_CHAT?: string;
  MAX_CHATS_PER_RUN?: string;
  CONTAINER_TIMEOUT_MS?: string;
}

// ---------------------------------------------------------------------------
// Container request/response contract (mirrors apps/ingest/container/main.py)
// ---------------------------------------------------------------------------

/** One cursor entry handed to the container: fetch messages with id > min_id. */
interface CursorEntry {
  chat_id: number;
  min_id: number;
  chat_title: string | null;
}

interface FetchRequest {
  /** Per-chat resume points. Empty => the container discovers dialogs itself. */
  cursors: CursorEntry[];
  /** Max messages to pull per chat this run (backpressure). */
  fetch_limit_per_chat: number;
  /** 0 => no cap. Limits how many dialogs are touched per run. */
  max_chats: number;
}

/** A message as serialized by the container (maps onto @crm/db MessageInput). */
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

/** Per-chat advanced cursor returned by the container. */
interface AdvancedCursor {
  chat_id: number;
  last_message_id: number;
  chat_title: string | null;
}

interface FetchResponse {
  messages: ContainerMessage[];
  cursors: AdvancedCursor[];
  /** Non-fatal per-chat errors (e.g. flood wait); logged, not thrown. */
  errors?: Array<{ chat_id: number | null; error: string }>;
}

// ---------------------------------------------------------------------------
// scheduled handler
// ---------------------------------------------------------------------------

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIngest(env));
  },

  // Manual trigger for local dev / backfill smoke tests:
  //   curl http://localhost:8787/__run
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/__run') {
      const result = await runIngest(env);
      return Response.json(result);
    }
    return new Response('ingest worker: cron-driven. POST /__run to trigger manually.\n', {
      status: 200,
    });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

interface RunResult {
  chats_seen: number;
  messages_written: number;
  cursors_advanced: number;
  container_errors: number;
}

async function runIngest(env: Env): Promise<RunResult> {
  if (!env.TG_SESSION || !env.TG_API_ID || !env.TG_API_HASH) {
    throw new Error(
      'ingest: missing Telegram credentials (TG_SESSION / TG_API_ID / TG_API_HASH). Set them with `wrangler secret put`.'
    );
  }

  const fetchLimit = parseIntOr(env.FETCH_LIMIT_PER_CHAT, 200);
  const maxChats = parseIntOr(env.MAX_CHATS_PER_RUN, 0);
  const timeoutMs = parseIntOr(env.CONTAINER_TIMEOUT_MS, 150_000);

  // 1. read all chat cursors from D1.
  const cursors: ChatCursor[] = await getCursors(env.DB);
  const reqBody: FetchRequest = {
    cursors: cursors.map((c) => ({
      chat_id: c.chat_id,
      min_id: c.last_message_id,
      chat_title: c.chat_title,
    })),
    fetch_limit_per_chat: fetchLimit,
    max_chats: maxChats,
  };

  // 2. invoke the bound container. A single instance is enough for the
  //    serial catch-up; getContainer() routes to it by a stable id.
  const result = await callContainer(env, reqBody, timeoutMs);

  for (const e of result.errors ?? []) {
    console.warn(`ingest: container chat error chat_id=${e.chat_id ?? 'n/a'}: ${e.error}`);
  }

  // 3. write messages to D1 (idempotent on PK). upsertMessages stringifies
  //    raw_json for us when handed an object.
  let written = 0;
  if (result.messages.length > 0) {
    const inputs: MessageInput[] = result.messages.map((m) => ({
      chat_id: m.chat_id,
      message_id: m.message_id,
      sender_user_id: m.sender_user_id,
      chat_title: m.chat_title,
      text: m.text,
      msg_date: m.msg_date,
      is_outgoing: m.is_outgoing,
      raw_json: m.raw_json,
    }));
    written = await upsertMessages(env.DB, inputs);
  }

  // 4. advance cursors per chat. setCursor is monotonic (MAX guard in @crm/db),
  //    so overlapping cron runs never move a cursor backwards.
  let advanced = 0;
  for (const c of result.cursors) {
    if (c.last_message_id > 0) {
      await setCursor(env.DB, c.chat_id, c.last_message_id, c.chat_title);
      advanced++;
    }
  }

  const summary: RunResult = {
    chats_seen: result.cursors.length,
    messages_written: written,
    cursors_advanced: advanced,
    container_errors: result.errors?.length ?? 0,
  };
  // Diagnostic: how many resume cursors did we SEND to the container this run,
  // and the min_id range. If cursors_sent>0 but we still pull the same messages,
  // the re-fetch bug is container-side (min_id handling), not worker-side.
  console.log(
    `ingest: ${JSON.stringify(summary)} cursors_sent=${reqBody.cursors.length} ` +
      `sent=${JSON.stringify(reqBody.cursors.map((c) => ({ id: c.chat_id, min: c.min_id })))}`
  );
  return summary;
}

/**
 * POST the cursor map to the container's /fetch endpoint and parse the
 * messages + advanced cursors. TG_API_ID/HASH/SESSION are forwarded both via
 * the container env (envVars on the DO) and as request headers so the Python
 * side can read either; the headers cover the first cold-start invocation.
 */
async function callContainer(
  env: Env,
  body: FetchRequest,
  timeoutMs: number
): Promise<FetchResponse> {
  const container = getContainer(env.INGEST_CONTAINER);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await container.fetch('http://ingest-container/fetch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tg-api-id': env.TG_API_ID,
        'x-tg-api-hash': env.TG_API_HASH,
        'x-tg-session': env.TG_SESSION,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ingest: container /fetch returned ${res.status}: ${detail.slice(0, 500)}`);
    }

    const parsed = (await res.json()) as Partial<FetchResponse>;
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      cursors: Array.isArray(parsed.cursors) ? parsed.cursors : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseIntOr(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
