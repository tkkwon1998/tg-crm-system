/**
 * watchdog Worker (spec §5.5) — liveness-based.
 *
 * Runs on cron every 5 minutes. Checks (read from D1 via @crm/db):
 *
 *   1. Ingest liveness — the 'ingest' heartbeat in system_status must be recent
 *      AND its last run must have succeeded. This detects a REAL stall (ingest
 *      stopped running) or a failed run (Telegram session de-authed / container
 *      error). It deliberately does NOT look at message age: a quiet inbox is
 *      not a failure, and the old max(msg_date) check false-alarmed every 5 min
 *      on low-traffic accounts.
 *   2. Queue depth — crm_proposals 'pending' count must not exceed the ceiling.
 *
 * Alerting:
 *   - On failure: POST a Slack alert, but only when the failing set CHANGES or a
 *     cooldown has elapsed (no re-paging every 5 min while still broken).
 *   - On full success: ping the dead-man's-switch HEALTHCHECK_URL (its absence
 *     pages you). On recovery, post a one-line "all clear".
 *   - Alert state (signature + last alert time) is persisted in system_status.
 */

import { getStatus, recordStatus, countByStatus } from '@crm/db';
import type { ProposalStatus, SystemStatus } from '@crm/db';

export interface Env {
  DB: D1Database;
  SLACK_WEBHOOK_URL: string;
  HEALTHCHECK_URL: string;

  // non-secret config (wrangler.jsonc vars)
  /** Max seconds the ingest heartbeat may be stale before it's a stall. */
  INGEST_MAX_SILENCE_SECONDS?: number | string;
  /** Pending-proposal ceiling. */
  PENDING_PROPOSALS_CEILING?: number | string;
  /** Min seconds between repeat Slack alerts for the SAME failing set. */
  ALERT_COOLDOWN_SECONDS?: number | string;
}

const DEFAULT_INGEST_MAX_SILENCE_SECONDS = 600; // 10 min (ingest cron is 1 min)
const DEFAULT_PENDING_PROPOSALS_CEILING = 200;
const DEFAULT_ALERT_COOLDOWN_SECONDS = 3600; // re-alert at most hourly while broken

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface AlertState {
  /** Sorted, comma-joined names of currently-failing checks (''=all green). */
  signature: string;
  /** Unix seconds of the last Slack alert sent. */
  lastAlertAt: number;
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

// ---------------------------------------------------------------------------
// pure check / decision logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Evaluate ingest liveness from its heartbeat. Liveness, not message recency:
 * a healthy run with zero new messages still counts as alive.
 */
export function evaluateIngestLiveness(
  hb: Pick<SystemStatus, 'updated_at' | 'ok' | 'detail'> | null,
  now: number,
  maxSilence: number
): CheckResult {
  if (hb === null) {
    return {
      name: 'ingest_liveness',
      ok: false,
      detail: 'ingest has never recorded a run (pipeline not started?)',
    };
  }
  if (hb.ok === 0) {
    return {
      name: 'ingest_liveness',
      ok: false,
      detail: `ingest last run FAILED — likely Telegram session de-auth or container error: ${hb.detail ?? '(no detail)'}`,
    };
  }
  const age = now - hb.updated_at;
  if (age > maxSilence) {
    return {
      name: 'ingest_liveness',
      ok: false,
      detail: `STALLED: ingest has not run in ${age}s (> ${maxSilence}s threshold) — cron not firing or worker erroring`,
    };
  }
  return { name: 'ingest_liveness', ok: true, detail: `ingest ran ${age}s ago, last run OK` };
}

/**
 * Decide whether to send a Slack alert now: only when the failing set changed
 * since the last alert, or the cooldown has elapsed. Prevents 5-minute spam.
 */
export function shouldAlert(
  signature: string,
  prev: AlertState,
  now: number,
  cooldown: number
): boolean {
  if (signature === '') return false; // nothing failing
  if (signature !== prev.signature) return true; // new/changed failure
  return now - prev.lastAlertAt >= cooldown; // same failure, but cooldown elapsed
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

async function checkIngestLiveness(env: Env, now: number): Promise<CheckResult> {
  const maxSilence = toInt(env.INGEST_MAX_SILENCE_SECONDS, DEFAULT_INGEST_MAX_SILENCE_SECONDS);
  const hb = await getStatus(env.DB, 'ingest');
  return evaluateIngestLiveness(hb, now, maxSilence);
}

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

// ---------------------------------------------------------------------------
// Slack / healthcheck
// ---------------------------------------------------------------------------

async function postSlack(env: Env, text: string): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.error('watchdog: SLACK_WEBHOOK_URL not set; cannot send Slack message');
    return;
  }
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`watchdog: Slack webhook returned ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error('watchdog: failed to POST Slack:', err);
  }
}

async function pingHealthcheck(env: Env): Promise<void> {
  if (!env.HEALTHCHECK_URL) {
    console.error('watchdog: HEALTHCHECK_URL not set; cannot ping dead-man switch');
    return;
  }
  try {
    const res = await fetch(env.HEALTHCHECK_URL, { method: 'GET' });
    if (!res.ok) console.error(`watchdog: healthcheck ping returned ${res.status}`);
  } catch (err) {
    console.error('watchdog: failed to ping healthcheck:', err);
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function loadAlertState(env: Env): Promise<AlertState> {
  const row = await getStatus(env.DB, 'watchdog');
  if (row?.detail) {
    try {
      const s = JSON.parse(row.detail) as Partial<AlertState>;
      return { signature: s.signature ?? '', lastAlertAt: s.lastAlertAt ?? 0 };
    } catch {
      /* fall through */
    }
  }
  return { signature: '', lastAlertAt: 0 };
}

async function runWatchdog(env: Env): Promise<CheckResult[]> {
  const now = nowSeconds();

  const [liveness, queueDepth] = await Promise.all([
    checkIngestLiveness(env, now),
    checkQueueDepth(env),
  ]);
  const results = [liveness, queueDepth];
  for (const r of results) {
    console.log(`watchdog check ${r.name}: ${r.ok ? 'OK' : 'FAIL'} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  const signature = failed.map((r) => r.name).sort().join(',');
  const prev = await loadAlertState(env);
  const cooldown = toInt(env.ALERT_COOLDOWN_SECONDS, DEFAULT_ALERT_COOLDOWN_SECONDS);

  if (failed.length > 0) {
    const iso = new Date(now * 1000).toISOString();
    if (shouldAlert(signature, prev, now, cooldown)) {
      const lines = failed.map((c) => `• *${c.name}*: ${c.detail}`).join('\n');
      await postSlack(env, `:rotating_light: *CRM watchdog* — ${failed.length} failing check(s) at ${iso}\n${lines}`);
      await recordStatus(env.DB, 'watchdog', false, JSON.stringify({ signature, lastAlertAt: now }));
      console.error(`watchdog: alerted (${signature}); healthcheck intentionally NOT pinged`);
    } else {
      // Still failing but within cooldown — stay quiet, keep prior alert time.
      await recordStatus(env.DB, 'watchdog', false, JSON.stringify({ signature, lastAlertAt: prev.lastAlertAt }));
      console.log(`watchdog: ${failed.length} failing (${signature}) but alert suppressed by cooldown`);
    }
    // Never ping the dead-man's-switch on failure.
  } else {
    if (prev.signature !== '') {
      await postSlack(env, `:white_check_mark: *CRM watchdog* — all checks passing again at ${new Date(now * 1000).toISOString()}`);
    }
    await recordStatus(env.DB, 'watchdog', true, JSON.stringify({ signature: '', lastAlertAt: 0 }));
    await pingHealthcheck(env);
    console.log('watchdog: all checks passed; healthcheck pinged');
  }

  return results;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWatchdog(env).then(() => undefined));
  },

  async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const results = await runWatchdog(env);
    const ok = results.every((r) => r.ok);
    return new Response(JSON.stringify({ ok, checks: results }, null, 2), {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  },
};
