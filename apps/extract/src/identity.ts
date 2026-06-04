/**
 * Identity resolution (spec §5.2).
 *
 * Resolution order for a telegram_user_id:
 *   1. confirmed identity_map row        -> trusted, never re-matched
 *   2. exact phone query against Attio    -> high confidence (optional auto-confirm)
 *   3. fuzzy /objects/records/search      -> candidate(s) for human review
 *   4. unmatched                          -> persisted so it surfaces for manual linking
 *
 * Every outcome is persisted to identity_map via the @crm/db client (we never
 * write our own SQL). Only a 'confirmed' row (or an explicit phone-auto-confirm
 * policy) is treated as truth by the rest of the pipeline.
 *
 * Attio API: https://docs.attio.com/ — Bearer ATTIO_TOKEN.
 *   POST /v2/objects/{object}/records/query  (filter on attributes)
 *   We treat 'people' as the primary object.
 */

import {
  getIdentity,
  upsertIdentity,
  type IdentityCandidate,
  type IdentityMatch,
} from '@crm/db';
import type { Env, ThreadMessage } from './env.js';

const DEFAULT_ATTIO_BASE = 'https://api.attio.com';

/** Confidence at/above which an exact phone match is auto-confirmed. */
const PHONE_AUTO_CONFIRM_CONFIDENCE = 0.99;
/** Confidence assigned to a fuzzy name match (always a candidate, never truth). */
const FUZZY_MATCH_CONFIDENCE = 0.55;

export interface ResolvedIdentity {
  telegram_user_id: number;
  status: IdentityMatch['status'];
  attio_record_id: string | null;
  confidence: number;
  match_method: string | null;
  display_name: string | null;
  /** Candidate matches for human review (also persisted to candidates_json). */
  candidates: IdentityCandidate[];
  /** A compact Attio record snapshot to feed Claude (null when unmatched). */
  attio_snapshot: Record<string, unknown> | null;
}

/** Lightweight "signal" about the counterparty, scraped from the thread. */
export interface CounterpartySignals {
  telegram_user_id: number;
  display_name: string | null;
  /** E.164-ish phone numbers found in message text, deduped. */
  phones: string[];
}

// ---------------------------------------------------------------------------
// signal extraction (deterministic, no model involved)
// ---------------------------------------------------------------------------

const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/** Normalize to digits, keeping a leading '+'. */
function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

/**
 * Derive deterministic signals about the counterparty from the thread:
 * a display name (the chat title for a DM) and any phone numbers they shared.
 */
export function deriveSignals(
  counterpartyUserId: number,
  chatTitle: string | null,
  messages: ThreadMessage[]
): CounterpartySignals {
  const phones = new Set<string>();
  for (const m of messages) {
    if (m.is_outgoing === 1) continue; // only trust numbers the counterparty sent
    if (!m.text) continue;
    const matches = m.text.match(PHONE_RE);
    if (!matches) continue;
    for (const raw of matches) {
      const n = normalizePhone(raw);
      if (n) phones.add(n);
    }
  }
  return {
    telegram_user_id: counterpartyUserId,
    display_name: chatTitle,
    phones: [...phones],
  };
}

// ---------------------------------------------------------------------------
// Attio HTTP helpers
// ---------------------------------------------------------------------------

interface AttioRecord {
  id?: { record_id?: string };
  values?: Record<string, unknown>;
}

function attioBase(env: Env): string {
  return (env.ATTIO_API_BASE || DEFAULT_ATTIO_BASE).replace(/\/+$/, '');
}

async function attioFetch(
  env: Env,
  path: string,
  body: unknown
): Promise<{ ok: boolean; status: number; data: { data?: AttioRecord[] } | null }> {
  const res = await fetch(`${attioBase(env)}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.ATTIO_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let data: { data?: AttioRecord[] } | null = null;
  try {
    data = (await res.json()) as { data?: AttioRecord[] };
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

function recordId(rec: AttioRecord): string | null {
  return rec.id?.record_id ?? null;
}

function recordSnapshot(rec: AttioRecord): Record<string, unknown> {
  return { record_id: recordId(rec), values: rec.values ?? {} };
}

/**
 * Exact phone lookup against the Attio 'people' object. Returns the first
 * matching record, or null. Uses the records query endpoint with an equality
 * filter on the 'phone_numbers' attribute.
 */
async function queryByPhone(env: Env, phone: string): Promise<AttioRecord | null> {
  const { ok, data } = await attioFetch(env, '/v2/objects/people/records/query', {
    filter: { phone_numbers: phone },
    limit: 1,
  });
  if (!ok || !data?.data?.length) return null;
  return data.data[0] ?? null;
}

/**
 * Fuzzy search by display name against the 'people' object. Returns up to
 * `limit` candidate records. Uses a `$contains` name filter, which Attio
 * supports on text attributes.
 */
async function searchByName(
  env: Env,
  name: string,
  limit = 5
): Promise<AttioRecord[]> {
  const { ok, data } = await attioFetch(env, '/v2/objects/people/records/query', {
    filter: { name: { $contains: name } },
    limit,
  });
  if (!ok || !data?.data?.length) return [];
  return data.data;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Build a ResolvedIdentity straight from a stored row (no Attio calls). */
function fromRow(row: IdentityMatch, snapshot: Record<string, unknown> | null): ResolvedIdentity {
  let candidates: IdentityCandidate[] = [];
  if (row.candidates_json) {
    try {
      const parsed = JSON.parse(row.candidates_json);
      if (Array.isArray(parsed)) candidates = parsed as IdentityCandidate[];
    } catch {
      candidates = [];
    }
  }
  return {
    telegram_user_id: row.telegram_user_id,
    status: row.status,
    attio_record_id: row.attio_record_id,
    confidence: row.confidence,
    match_method: row.match_method,
    display_name: row.display_name,
    candidates,
    attio_snapshot: snapshot,
  };
}

/**
 * Resolve a counterparty to an Attio record and persist the outcome.
 *
 * @returns the resolved identity (status reflects what was persisted).
 */
export async function resolveIdentity(
  env: Env,
  signals: CounterpartySignals
): Promise<ResolvedIdentity> {
  const db = env.DB;
  const tgId = signals.telegram_user_id;

  // 1. Confirmed rows are truth: never re-match, never overwrite.
  const existing = await getIdentity(db, tgId);
  if (existing && existing.status === 'confirmed') {
    let snapshot: Record<string, unknown> | null = null;
    // Re-hydrate a snapshot for Claude if we still have the record id.
    if (existing.attio_record_id) {
      snapshot = { record_id: existing.attio_record_id, values: {} };
    }
    return fromRow(existing, snapshot);
  }

  // 2. Exact phone query -> Attio. Optionally auto-confirm.
  for (const phone of signals.phones) {
    let rec: AttioRecord | null = null;
    try {
      rec = await queryByPhone(env, phone);
    } catch {
      rec = null; // transient Attio error: fall through to other strategies
    }
    if (rec) {
      const rid = recordId(rec);
      if (rid) {
        const autoConfirm =
          (env.PHONE_AUTO_CONFIRM ?? 'true').toLowerCase() !== 'false';
        const status = autoConfirm ? 'confirmed' : 'candidate';
        const confidence = autoConfirm ? 1 : PHONE_AUTO_CONFIRM_CONFIDENCE;
        const candidate: IdentityCandidate = {
          attio_record_id: rid,
          confidence,
          match_method: 'phone_exact',
          label: signals.display_name ?? undefined,
          matched_on: { phone_numbers: phone },
        };
        await upsertIdentity(db, {
          telegram_user_id: tgId,
          attio_record_id: rid,
          status,
          confidence,
          match_method: 'phone_exact',
          candidates_json: [candidate],
          display_name: signals.display_name,
        });
        return {
          telegram_user_id: tgId,
          status,
          attio_record_id: rid,
          confidence,
          match_method: 'phone_exact',
          display_name: signals.display_name,
          candidates: [candidate],
          attio_snapshot: recordSnapshot(rec),
        };
      }
    }
  }

  // 3. Fuzzy name search -> candidate(s) for review. Never auto-confirmed.
  if (signals.display_name) {
    let recs: AttioRecord[] = [];
    try {
      recs = await searchByName(env, signals.display_name);
    } catch {
      recs = [];
    }
    const candidates: IdentityCandidate[] = recs
      .map((r) => recordId(r))
      .filter((id): id is string => Boolean(id))
      .map((id, i) => ({
        attio_record_id: id,
        // Rank earlier results slightly higher; all stay below the auto bar.
        confidence: Math.max(0.2, FUZZY_MATCH_CONFIDENCE - i * 0.05),
        match_method: 'fuzzy_search',
        label: signals.display_name ?? undefined,
        matched_on: { name: signals.display_name },
      }));

    if (candidates.length > 0) {
      const top = candidates[0]!;
      await upsertIdentity(db, {
        telegram_user_id: tgId,
        // A candidate is NOT truth: leave attio_record_id null so the apply
        // Worker never writes off an unconfirmed fuzzy hit (guardrail #2).
        attio_record_id: null,
        status: 'candidate',
        confidence: top.confidence,
        match_method: 'fuzzy_search',
        candidates_json: candidates,
        display_name: signals.display_name,
      });
      return {
        telegram_user_id: tgId,
        status: 'candidate',
        attio_record_id: null,
        confidence: top.confidence,
        match_method: 'fuzzy_search',
        display_name: signals.display_name,
        candidates,
        attio_snapshot: null,
      };
    }
  }

  // 4. Unmatched. Persist so it surfaces in the review queue (don't clobber a
  //    previously richer row's candidates — upsert COALESCEs them).
  await upsertIdentity(db, {
    telegram_user_id: tgId,
    attio_record_id: null,
    status: 'unmatched',
    confidence: 0,
    match_method: 'no_match',
    display_name: signals.display_name,
  });
  return {
    telegram_user_id: tgId,
    status: 'unmatched',
    attio_record_id: null,
    confidence: 0,
    match_method: 'no_match',
    display_name: signals.display_name,
    candidates: [],
    attio_snapshot: null,
  };
}
