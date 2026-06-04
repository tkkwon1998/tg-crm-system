/**
 * apply Worker (spec §5.4, §7) — people + deals.
 *
 * On cron, find proposals eligible to write to Attio:
 *   - status 'approved' (explicit human decision), OR
 *   - status 'pending' that pass the code-enforced auto-apply gate.
 *
 * PEOPLE proposals: assert_person (upsert deduped on a matching attr) + note.
 * DEAL proposals (group-chat model): the write target is the LIVE confirmed deal
 *   from deal_map (resolved at apply-time by telegram_chat_id — so a match a human
 *   confirms via `link-deal` AFTER extraction still takes effect). For a confirmed
 *   deal we:
 *     1. patch allowlisted (non-stage) fields, if any,
 *     2. associate confirmed participants as people on the deal (read-merge-write,
 *        never clobbering existing contacts),
 *     3. attach a provenance note citing the source chat_id:message_id list.
 *   Stage/commercial/non-allowlisted fields and unconfirmed deals route to review.
 *
 * Idempotency: only 'approved'/'pending' are read and transitioned to 'applied'
 * on success; an 'applied' proposal is never re-read.
 */

import {
  getDealMap,
  listByStatus,
  markStatus,
  type Proposal,
  type ProposalParticipant,
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
  DEAL_SAFE_ATTRIBUTE_ALLOWLIST?: string;
  ATTIO_PEOPLE_MATCHING_ATTRIBUTE?: string;
  /** The Deals attribute that holds associated people (record reference). */
  ATTIO_DEAL_PEOPLE_ATTRIBUTE?: string;
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
      env.SAFE_ATTRIBUTE_ALLOWLIST ?? 'phone,phone_numbers,email,email_addresses,job_title,title'
    ),
    dealSafeAttributeAllowlist: parseAllowlist(
      env.DEAL_SAFE_ATTRIBUTE_ALLOWLIST ??
        'next_step,next_steps,next_step_date,last_touch,last_touch_date,last_contacted'
    ),
  };
}

function parseParticipants(p: Proposal): ProposalParticipant[] {
  if (!p.participants_json) return [];
  try {
    const v = JSON.parse(p.participants_json);
    return Array.isArray(v) ? (v as ProposalParticipant[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// note bodies
// ---------------------------------------------------------------------------

function buildPersonNote(p: Proposal, changes: Record<string, unknown>, sources: string[]): string {
  const changeLines = Object.entries(changes).map(([s, v]) => `- \`${s}\`: ${JSON.stringify(v)}`).join('\n');
  return [
    '## Automated CRM enrichment from Telegram',
    '',
    `Applied by the **apply** Worker from proposal #${p.id} (status \`${p.status}\`, confidence ${p.confidence}).`,
    '',
    '### Changes',
    changeLines || '_(none)_',
    '',
    `### Suggested action\n\`${p.suggested_action}\``,
    '',
    p.rationale ? `### Rationale\n${p.rationale}\n` : '',
    '### Source messages (chat_id:message_id)',
    sources.map((s) => `- ${s}`).join('\n') || '_(none)_',
  ].filter((l) => l !== '').join('\n');
}

function buildDealNote(
  p: Proposal,
  changes: Record<string, unknown>,
  sources: string[],
  participants: ProposalParticipant[]
): string {
  const changeLines = Object.entries(changes).map(([s, v]) => `- \`${s}\`: ${JSON.stringify(v)}`).join('\n');
  const partLines = participants
    .map((pt) => `- ${pt.name ?? `tg:${pt.telegram_user_id}`}${pt.attio_person_id ? ` (linked)` : ''}${pt.role ? ` — ${pt.role}` : ''}`)
    .join('\n');
  return [
    '## Telegram deal enrichment',
    '',
    `From proposal #${p.id} (status \`${p.status}\`, confidence ${p.confidence}), chat \`${p.telegram_chat_id}\`.`,
    '',
    `### Suggested action\n\`${p.suggested_action}\``,
    '',
    p.rationale ? `### Summary\n${p.rationale}\n` : '',
    '### Field updates',
    changeLines || '_(none — note + participants only)_',
    '',
    '### Participants',
    partLines || '_(none resolved)_',
    '',
    '### Source messages (chat_id:message_id)',
    sources.map((s) => `- ${s}`).join('\n') || '_(none)_',
  ].filter((l) => l !== '').join('\n');
}

// ---------------------------------------------------------------------------
// apply: people
// ---------------------------------------------------------------------------

async function applyPerson(
  db: D1Database,
  attio: AttioClient,
  matchingAttribute: string,
  p: Proposal
): Promise<boolean> {
  const changes = parseProposedChanges(p);
  const sources = parseSourceMessageIds(p);
  const recordId = p.attio_record_id!;
  try {
    const record = await attio.assertRecord('people', matchingAttribute, changes);
    const writtenRecordId = record.id?.record_id ?? recordId;
    await attio.createNote({
      parentObject: 'people',
      parentRecordId: writtenRecordId,
      title: `Telegram enrichment — proposal #${p.id}`,
      content: buildPersonNote(p, changes, sources),
    });
    await markStatus(db, p.id, 'applied', null);
    return true;
  } catch (e) {
    await markStatus(db, p.id, p.status, errMsg(e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// apply: deals
// ---------------------------------------------------------------------------

/** Add people to a deal's reference attribute WITHOUT clobbering existing contacts. */
async function associatePeople(
  attio: AttioClient,
  dealId: string,
  peopleAttr: string,
  newPersonIds: string[]
): Promise<void> {
  const rec = await attio.getRecord('deals', dealId);
  const currentVal = rec.values?.[peopleAttr];
  const current: string[] = Array.isArray(currentVal)
    ? currentVal
        .map((v) => (v && typeof v === 'object' ? (v as { target_record_id?: string }).target_record_id : undefined))
        .filter((x): x is string => typeof x === 'string')
    : [];
  const merged = Array.from(new Set([...current, ...newPersonIds]));
  if (merged.length === current.length) return; // nothing new to add
  await attio.patchRecord('deals', dealId, {
    [peopleAttr]: merged.map((id) => ({ target_object: 'people', target_record_id: id })),
  });
}

async function applyDeal(db: D1Database, attio: AttioClient, env: Env, p: Proposal): Promise<boolean> {
  const changes = parseProposedChanges(p);
  const sources = parseSourceMessageIds(p);
  const participants = parseParticipants(p);
  const dealId = p.attio_record_id!; // effective confirmed deal id (resolved in run())
  const peopleAttr = env.ATTIO_DEAL_PEOPLE_ATTRIBUTE ?? 'associated_people';

  try {
    // 1. allowlisted/approved field updates (often none — schema may have no safe fields).
    if (Object.keys(changes).length > 0) {
      await attio.patchRecord('deals', dealId, changes);
    }
    // 2. associate confirmed participants (people with a resolved Attio id).
    const newPersonIds = participants
      .map((pt) => pt.attio_person_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (newPersonIds.length > 0) {
      await associatePeople(attio, dealId, peopleAttr, newPersonIds);
    }
    // 3. provenance note (always — the traceable record of this enrichment).
    await attio.createNote({
      parentObject: 'deals',
      parentRecordId: dealId,
      title: `Telegram deal enrichment — proposal #${p.id}`,
      content: buildDealNote(p, changes, sources, participants),
    });
    await markStatus(db, p.id, 'applied', null);
    return true;
  } catch (e) {
    await markStatus(db, p.id, p.status, errMsg(e));
    return false;
  }
}

function errMsg(e: unknown): string {
  const msg = e instanceof AttioError ? `${e.message} :: ${e.body}` : (e as Error)?.message ?? String(e);
  return msg.slice(0, 2000);
}

/**
 * For a deal proposal, the write target is the LIVE confirmed deal (deal_map),
 * not the possibly-stale id frozen on the proposal at extraction time. Returns a
 * proposal whose attio_record_id is the current confirmed deal id (or null).
 */
async function withEffectiveTarget(db: D1Database, p: Proposal): Promise<Proposal> {
  if (p.attio_object !== 'deals' || p.telegram_chat_id == null) return p;
  const dm = await getDealMap(db, p.telegram_chat_id);
  const liveDealId = dm && dm.status === 'confirmed' ? dm.attio_deal_id : null;
  return { ...p, attio_record_id: liveDealId };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function run(env: Env): Promise<RunResult> {
  const cfg = loadConfig(env);
  const limit = num(env.APPLY_BATCH_LIMIT, 50);
  const matchingAttribute = env.ATTIO_PEOPLE_MATCHING_ATTRIBUTE ?? 'email_addresses';
  const attio = new AttioClient(env.ATTIO_TOKEN, env.ATTIO_API_BASE ?? 'https://api.attio.com');

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

  const result: RunResult = { considered: candidates.length, applied: 0, skipped: 0, failed: 0, blocked: 0 };

  for (const raw of candidates) {
    const p = await withEffectiveTarget(env.DB, raw);
    const decision = decide(p, cfg);
    switch (decision.kind) {
      case 'skip':
        result.skipped++;
        console.log(`proposal #${p.id} skipped: ${decision.reason}`);
        break;
      case 'block':
        result.blocked++;
        console.warn(`proposal #${p.id} blocked: ${decision.reason}`);
        await markStatus(env.DB, p.id, p.status, `blocked: ${decision.reason}`);
        break;
      case 'apply': {
        const ok =
          p.attio_object === 'deals'
            ? await applyDeal(env.DB, attio, env, p)
            : await applyPerson(env.DB, attio, matchingAttribute, p);
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
    `apply run: considered=${result.considered} applied=${result.applied} skipped=${result.skipped} blocked=${result.blocked} failed=${result.failed}`
  );
  return result;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env).then(() => undefined));
  },

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
