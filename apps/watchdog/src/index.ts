/**
 * watchdog Worker (spec §5.5).
 *
 * Runs on cron every 5 minutes. Two health checks, both read from D1 via the
 * @crm/db client (never hand-rolled SQL):
 *
 *   1. Freshness — max(msg_date) must be within FRESHNESS_MAX_AGE_SECONDS of now.
 *      A stale newest message means ingestion stalled or the Telegram session
 *      was de-authed.
 *   2. Queue depth — crm_proposals 'pending' count must not exceed
 *      PENDING_PROPOSALS_CEILING. A runaway pending count means apply stalled
 *      or review is falling behind.
 *
 * Failure semantics (the whole point of a watchdog):
 *   - On ANY failed check: POST a human-readable alert to the Slack webhook.
 *   - Ping the dead-man's-switch HEALTHCHECK_URL ONLY when every check passes.
 *     The ABSENCE of a ping is what pages you (e.g. healthchecks.io), so a
 *     watchdog that itself dies still surfaces — we never ping on failure and
 *     never ping if the run throws.
 *
 * Everything here is observable from a terminal via `wrangler tail watchdog`.
 */

import { getNewestMessageDate, countByStatus } from '@crm/db';
import type { ProposalStatus } from '@crm/db';

export interface Env {
  /** Shared D1 (binding MUST be "DB"). */
  DB: D1Database;

  // --- secrets (wrangler secret put) ---
  /** Slack Incoming Webhook URL for alerts. */
  SLACK_WEBHOOK_URL: string;
  /** Dead-man's-switch URL (e.g. healthchecks.io). Pinged only on full success. */
  HEALTHCHECK_URL: string;

  // --- non-secret config (wrangler.jsonc vars; JSON numbers arrive as numbers,
  //     but treat defensively in case they are provided as strings) ---
  FRESHNESS_MAX_AGE_SECONDS?: number | string;
  PENDING_PROPOSALS_CEILING?: number | string;
}

/** Defaults mirror wrangler.jsonc; used if a var is missing/unparseable. */
const DEFAULT_FRESHNESS_MAX_AGE_SECONDS = 900; // 15 min
const DEFAULT_PENDING_PROPOSALS_CEILING = 200;

/** One health-check outcome. */
interface CheckResult {
  name: string;
  ok: boolean;
  /** One-line, human-readable detail for logs + Slack. */
  detail: string;
}

function toInt(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Check 1: ingestion freshness. */
async function checkFreshness(env: Env, now: number): Promise<CheckResult> {
  const maxAge = toInt(env.FRESHNESS_MAX_AGE_SECONDS, DEFAULT_FRESHNESS_MAX_AGE_SECONDS);
  const newest = await getNewestMessageDate(env.DB);

  if (newest === null) {
    // No messages at all. Before any ingestion has happened this is expected,
    // but a watchdog that stayed silent here would hide a never-started pipeline.
    // Treat an empty store as stale so the operator notices a system that never
    // produced data.
    return {
      name: 'freshness',
      ok: false,
      detail: `no messages in telegram_messages yet (max(msg_date) is NULL); ingestion has never produced data`,
    };
  }

  const age = now - newest;
  const ok = age <= maxAge;
  return {
    name: 'freshness',
    ok,
    detail: ok
      ? `newest message ${age}s old (<= ${maxAge}s threshold)`
      : `STALE: newest message ${age}s old (> ${maxAge}s threshold) — ingestion stalled or Telegram session de-authed`,
  };
}

/** Check 2: pending proposal queue depth. */
async function checkQueueDepth(env: Env): Promise<CheckResult> {
  const ceiling = toInt(env.PENDING_PROPOSALS_CEILING, DEFAULT_PENDING_PROPOSALS_CEILING);
  const counts: Record<ProposalStatus, number> = await countByStatus(env.DB);
  const pending = counts.pending;
  const ok = pending <= ceiling;
  return {
    name: 'queue_depth',
    ok,
    detail: ok
      ? `${pending} pending proposals (<= ${ceiling} ceiling)`
      : `BACKLOG: ${pending} pending proposals (> ${ceiling} ceiling) — apply stalled or review falling behind`,
  };
}

/** POST a Slack alert. Best-effort: log on failure but never throw past here. */
async function postSlackAlert(env: Env, failed: CheckResult[], now: number): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.error('watchdog: SLACK_WEBHOOK_URL is not set; cannot send alert');
    return;
  }

  const iso = new Date(now * 1000).toISOString();
  const lines = failed.map((c) => `• *${c.name}*: ${c.detail}`).join('\n');
  const text = `:rotating_light: *CRM watchdog* detected ${failed.length} failing check(s) at ${iso}\n${lines}`;

  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`watchdog: Slack webhook returned ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error('watchdog: failed to POST Slack alert:', err);
  }
}

/** Ping the dead-man's-switch. Called ONLY when all checks pass. */
async function pingHealthcheck(env: Env): Promise<void> {
  if (!env.HEALTHCHECK_URL) {
    console.error('watchdog: HEALTHCHECK_URL is not set; cannot ping dead-man switch');
    return;
  }
  try {
    const res = await fetch(env.HEALTHCHECK_URL, { method: 'GET' });
    if (!res.ok) {
      console.error(`watchdog: healthcheck ping returned ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error('watchdog: failed to ping healthcheck:', err);
  }
}

/**
 * Run all checks, alert on failures, ping on full success.
 * Returns the check results so it can be exercised from both cron and fetch.
 */
async function runWatchdog(env: Env): Promise<CheckResult[]> {
  const now = nowSeconds();

  // Run the independent reads concurrently.
  const [freshness, queueDepth] = await Promise.all([
    checkFreshness(env, now),
    checkQueueDepth(env),
  ]);
  const results = [freshness, queueDepth];

  for (const r of results) {
    console.log(`watchdog check ${r.name}: ${r.ok ? 'OK' : 'FAIL'} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);

  if (failed.length > 0) {
    // Alert loudly. Do NOT ping the healthcheck — the missing ping is the page.
    await postSlackAlert(env, failed, now);
    console.error(`watchdog: ${failed.length} check(s) failed; Slack alerted, healthcheck intentionally NOT pinged`);
  } else {
    // All green: feed the dead-man switch so its absence stays meaningful.
    await pingHealthcheck(env);
    console.log('watchdog: all checks passed; healthcheck pinged');
  }

  return results;
}

export default {
  /** Cron entrypoint (every 5 min). */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Let alert/ping fetches finish even after the handler returns.
    ctx.waitUntil(runWatchdog(env).then(() => undefined));
  },

  /**
   * HTTP entrypoint — lets you trigger a check on demand from the terminal
   * (e.g. `curl https://watchdog.<acct>.workers.dev/`) and see the JSON result.
   * Returns 200 when all checks pass, 503 when any fail.
   */
  async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const results = await runWatchdog(env);
    const ok = results.every((r) => r.ok);
    return new Response(JSON.stringify({ ok, checks: results }, null, 2), {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  },
};
