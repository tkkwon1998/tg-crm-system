/**
 * apply Worker (spec §5.4, §7).
 *
 * On cron, find proposals that are eligible to be written to Attio:
 *   - status 'approved'   (an explicit human decision), OR
 *   - status 'pending' that pass the code-enforced auto-apply gate
 *     (confidence >= threshold AND every changed attribute on the safe allowlist).
 *
 * For each eligible proposal, against its existing Attio record:
 *   1. assert_person — PUT the proposed_changes, deduped on a matching attribute.
 *   2. create_note   — attach a provenance note citing the source
 *                      chat_id:message_id list, so every CRM write is traceable.
 * Then mark the proposal 'applied' (applied_at set by @crm/db). On failure the
 * proposal keeps its status and the error string is recorded for the dashboard.
 *
 * Idempotency: we only ever read 'approved'/'pending' proposals and transition
 * them to 'applied' on success. Attio assert is itself idempotent (upsert on the
 * matching attribute). Overlapping or retried cron runs are therefore safe; a
 * proposal already 'applied' is never re-read.
 */

import {
  listByStatus,
  markStatus,
  type Proposal,
} from '@crm/db';
import { AttioClient, AttioError } from './attio.js';
import {
  decide,
  parseAllowlist,
  parseProposedChanges,
  parseSourceMessageIds,
  type ApplyConfig,
} from './guardrails.js';

export interface Env {
  DB: D1Database;
  // secret
  ATTIO_TOKEN: string;
  // vars (strings in wrangler.jsonc)
  AUTO_APPLY_CONFIDENCE_THRESHOLD?: string;
  SAFE_ATTRIBUTE_ALLOWLIST?: string;
  ATTIO_PEOPLE_MATCHING_ATTRIBUTE?: string;
  ATTIO_API_BASE?: string;
  APPLY_BATCH_LIMIT?: string;
}

interface RunResult {
  considered: number;
  applied: number;
  skipped: number;
  failed: number;
  blocked: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function loadConfig(env: Env): ApplyConfig {
  return {
    autoApplyConfidenceThreshold: num(env.AUTO_APPLY_CONFIDENCE_THRESHOLD, 0.9),
    safeAttributeAllowlist: parseAllowlist(
      env.SAFE_ATTRIBUTE_ALLOWLIST ??
        'phone,phone_numbers,email,email_addresses,job_title,title'
    ),
  };
}

/** Build the provenance note body for an applied proposal. */
function buildNoteContent(p: Proposal, changes: Record<string, unknown>, sources: string[]): string {
  const changeLines = Object.entries(changes)
    .map(([slug, val]) => `- \`${slug}\`: ${JSON.stringify(val)}`)
    .join('\n');
  const sourceLines = sources.map((s) => `- ${s}`).join('\n');
  return [
    '## Automated CRM enrichment from Telegram',
    '',
    `Applied by the **apply** Worker from proposal #${p.id} ` +
      `(status \`${p.status}\`, confidence ${p.confidence}).`,
    '',
    '### Changes',
    changeLines || '_(none)_',
    '',
    '### Suggested action',
    `\`${p.suggested_action}\``,
    '',
    p.rationale ? `### Rationale\n${p.rationale}\n` : '',
    '### Source messages (chat_id:message_id)',
    sourceLines || '_(none)_',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Apply one proposal. Returns true on success (proposal marked 'applied').
 * On a write failure the proposal keeps its current status with an error string.
 */
async function applyOne(
  db: D1Database,
  attio: AttioClient,
  matchingAttribute: string,
  p: Proposal
): Promise<boolean> {
  // changes / sources already validated by decide(); re-parse for the write.
  const changes = parseProposedChanges(p);
  const sources = parseSourceMessageIds(p);
  const recordId = p.attio_record_id!; // non-null guaranteed by decide()

  try {
    // 1. assert_person — upsert proposed changes, deduped on the matching attr.
    //    We also include the matching attribute's current value implicitly via
    //    the record's existing data; Attio resolves the record by value, so for
    //    a known record we still pass the changes and rely on the matching attr
    //    present in `changes` when available. If the matching attribute is not
    //    among the changes, the assert still upserts by whatever value is
    //    present; the record is the same person resolved upstream.
    const record = await attio.assertRecord('people', matchingAttribute, changes);
    const writtenRecordId = record.id?.record_id ?? recordId;

    // 2. create_note — provenance trail (spec §12: every write must be traceable).
    await attio.createNote({
      parentObject: 'people',
      parentRecordId: writtenRecordId,
      title: `Telegram enrichment — proposal #${p.id}`,
      content: buildNoteContent(p, changes, sources),
    });

    // 3. mark applied (clears any prior error; applied_at set by @crm/db).
    await markStatus(db, p.id, 'applied', null);
    return true;
  } catch (e) {
    const msg =
      e instanceof AttioError
        ? `${e.message} :: ${e.body}`
        : (e as Error).message ?? String(e);
    // Keep the proposal in its current status so it is retried / reviewed;
    // record the error for `make status` / the watchdog.
    await markStatus(db, p.id, p.status, msg.slice(0, 2000));
    return false;
  }
}

/** Core run: gather candidates, gate them, apply the eligible ones. */
export async function run(env: Env): Promise<RunResult> {
  const cfg = loadConfig(env);
  const limit = num(env.APPLY_BATCH_LIMIT, 50);
  const matchingAttribute = env.ATTIO_PEOPLE_MATCHING_ATTRIBUTE ?? 'email_addresses';
  const attio = new AttioClient(env.ATTIO_TOKEN, env.ATTIO_API_BASE ?? 'https://api.attio.com');

  // Candidates: explicit human-approved first, then pending (auto-apply gate).
  // Dedupe by id in case a status changes mid-run.
  const approved = await listByStatus(env.DB, 'approved', limit);
  const remaining = Math.max(0, limit - approved.length);
  const pending = remaining > 0 ? await listByStatus(env.DB, 'pending', remaining) : [];

  const seen = new Set<number>();
  const candidates: Proposal[] = [];
  for (const p of [...approved, ...pending]) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      candidates.push(p);
    }
  }

  const result: RunResult = {
    considered: candidates.length,
    applied: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
  };

  for (const p of candidates) {
    const decision = decide(p, cfg);
    switch (decision.kind) {
      case 'skip':
        // Leave pending for human review / later confidence; no DB change.
        result.skipped++;
        console.log(`proposal #${p.id} skipped: ${decision.reason}`);
        break;
      case 'block':
        // Reached us (e.g. human-approved) but an absolute guardrail forbids the
        // write. Record the reason; leave status unchanged for a human to handle.
        result.blocked++;
        console.warn(`proposal #${p.id} blocked: ${decision.reason}`);
        await markStatus(env.DB, p.id, p.status, `blocked: ${decision.reason}`);
        break;
      case 'apply': {
        const ok = await applyOne(env.DB, attio, matchingAttribute, p);
        if (ok) {
          result.applied++;
          console.log(`proposal #${p.id} applied (${decision.reason})`);
        } else {
          result.failed++;
          console.error(`proposal #${p.id} failed to apply`);
        }
        break;
      }
    }
  }

  console.log(
    `apply run: considered=${result.considered} applied=${result.applied} ` +
      `skipped=${result.skipped} blocked=${result.blocked} failed=${result.failed}`
  );
  return result;
}

export default {
  /** Cron entrypoint. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env).then(() => undefined));
  },

  /**
   * HTTP entrypoint for terminal-driven manual runs:
   *   curl -X POST https://apply.<acct>.workers.dev/run
   * GET / returns a tiny health string.
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/run') {
      const result = await run(env);
      return Response.json(result);
    }
    return new Response('apply Worker — POST /run to apply eligible proposals\n', {
      headers: { 'content-type': 'text/plain' },
    });
  },
} satisfies ExportedHandler<Env>;
