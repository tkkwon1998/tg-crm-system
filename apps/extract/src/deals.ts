/**
 * Deal resolution (deal-centric flow).
 *
 * Maps a Telegram GROUP chat to an Attio *deal* record by fuzzy-matching the
 * chat title against deal names:
 *   1. confirmed deal_map row        -> trusted, never re-matched
 *   2. fuzzy chat_title -> deal name  -> auto-confirm if score >= threshold,
 *                                        else candidate(s) for human review
 *   3. unmatched                      -> persisted so it surfaces for manual linking
 *
 * Every outcome is persisted to deal_map via the @crm/db client. Only a
 * 'confirmed' mapping is treated as a write target by the rest of the pipeline.
 *
 * Attio API: POST /v2/objects/deals/records/query (Bearer ATTIO_TOKEN).
 */

import { getDealMap, upsertDealMap, type DealCandidate, type DealMatch } from '@crm/db';
import type { Env } from './env.js';

const DEFAULT_ATTIO_BASE = 'https://api.attio.com';
/** Fuzzy score (0-1) at/above which a title match is eligible to auto-confirm. */
const DEFAULT_AUTO_CONFIRM_SCORE = 0.82;
/** Minimum score to surface as a review candidate at all. */
const MIN_CANDIDATE_SCORE = 0.4;
/**
 * The top match must beat the runner-up by at least this margin to auto-confirm.
 * Guards against same-company collisions (e.g. a "Binance" chat matching both
 * "Binance Wallet" and "Binance Earn" at near-identical scores) — ambiguous
 * matches become human-review candidates instead of a wrong auto-attribution.
 */
const DEFAULT_DISAMBIGUATION_MARGIN = 0.15;

/**
 * Decide whether the top fuzzy match is safe to auto-confirm (hybrid policy):
 * it must clear the absolute score bar AND clearly beat the runner-up.
 * Pure + exported for testing.
 */
export function isClearWinner(
  scores: number[],
  autoConfirmScore: number,
  margin: number
): boolean {
  if (scores.length === 0) return false;
  const sorted = [...scores].sort((a, b) => b - a);
  const top = sorted[0]!;
  const second = sorted[1] ?? 0;
  return top >= autoConfirmScore && top - second >= margin;
}

export interface ResolvedDeal {
  chat_id: number;
  status: DealMatch['status'];
  attio_deal_id: string | null;
  confidence: number;
  match_method: string | null;
  candidates: DealCandidate[];
  /** Compact deal snapshot to feed Claude (null when unmatched). */
  deal_snapshot: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// fuzzy title matching (deterministic, no model)
// ---------------------------------------------------------------------------

/** Normalize a name for comparison: lowercase, strip punctuation, collapse ws. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter((t) => t.length > 1));
}

/**
 * Token-overlap (Jaccard-ish) similarity between a chat title and a deal name,
 * in [0,1]. Robust to ordering and extra words (e.g. chat "evan / noel / theo"
 * vs deal "Theo x Acme"). Exact normalized equality scores 1.
 */
export function titleSimilarity(chatTitle: string, dealName: string): number {
  const a = normalize(chatTitle);
  const b = normalize(dealName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = tokenSet(chatTitle);
  const sb = tokenSet(dealName);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  const jaccard = inter / union;
  // Boost when one is a subset of the other (deal name often a subset of title).
  const containment = inter / Math.min(sa.size, sb.size);
  return Math.max(jaccard, 0.6 * containment + 0.4 * jaccard);
}

// ---------------------------------------------------------------------------
// Attio
// ---------------------------------------------------------------------------

interface AttioRecord {
  id?: { record_id?: string };
  values?: Record<string, unknown>;
}

function attioBase(env: Env): string {
  return (env.ATTIO_API_BASE || DEFAULT_ATTIO_BASE).replace(/\/+$/, '');
}

/** Pull a human-readable deal name out of an Attio record's values. */
function dealName(rec: AttioRecord): string {
  const v = rec.values ?? {};
  // Attio attribute values are arrays of typed objects; name is usually under
  // a 'name' (or 'title') text attribute. Be defensive about shape.
  for (const key of ['name', 'title', 'deal_name']) {
    const attr = (v as Record<string, unknown>)[key];
    if (Array.isArray(attr) && attr.length > 0) {
      const first = attr[0] as Record<string, unknown>;
      const val = first.value ?? first.text ?? first.full_name;
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
  }
  return '';
}

function recordId(rec: AttioRecord): string | null {
  return rec.id?.record_id ?? null;
}

export interface AttioDealsDiag {
  ok: boolean;
  status: number | null;
  count: number;
  sampleNames: string[];
  error: string | null;
}

/**
 * Diagnostic: live Attio deals query that does NOT swallow errors, so we can
 * positively confirm reads work (and see deal names) vs. a silent failure.
 */
export async function attioDealsDiag(env: Env, limit = 200): Promise<AttioDealsDiag> {
  try {
    const res = await fetch(`${attioBase(env)}/v2/objects/deals/records/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.ATTIO_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, count: 0, sampleNames: [], error: body.slice(0, 400) };
    }
    const data = (await res.json()) as { data?: AttioRecord[] };
    const recs = Array.isArray(data.data) ? data.data : [];
    return {
      ok: true,
      status: res.status,
      count: recs.length,
      sampleNames: recs.map(dealName).filter((n) => n).slice(0, 30),
      error: null,
    };
  } catch (e) {
    return { ok: false, status: null, count: 0, sampleNames: [], error: (e as Error).message };
  }
}

/**
 * List deals from Attio (paged once). THROWS on a failed read so the caller (the
 * Workflow step) RETRIES rather than caching a false 'unmatched' — a swallowed
 * transient error previously poisoned matches permanently.
 */
async function listDeals(env: Env, limit = 200): Promise<AttioRecord[]> {
  const res = await fetch(`${attioBase(env)}/v2/objects/deals/records/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ATTIO_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Attio deals query ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: AttioRecord[] };
  return Array.isArray(data.data) ? data.data : [];
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

function fromRow(row: DealMatch, snapshot: Record<string, unknown> | null): ResolvedDeal {
  let candidates: DealCandidate[] = [];
  if (row.candidates_json) {
    try {
      const parsed = JSON.parse(row.candidates_json);
      if (Array.isArray(parsed)) candidates = parsed as DealCandidate[];
    } catch {
      candidates = [];
    }
  }
  return {
    chat_id: row.chat_id,
    status: row.status,
    attio_deal_id: row.attio_deal_id,
    confidence: row.confidence,
    match_method: row.match_method,
    candidates,
    deal_snapshot: snapshot,
  };
}

/**
 * Resolve a group chat to an Attio deal and persist the outcome to deal_map.
 */
export async function resolveDeal(
  env: Env,
  chatId: number,
  chatTitle: string | null
): Promise<ResolvedDeal> {
  const db = env.DB;

  // 1. Confirmed mappings are truth: never re-match.
  const existing = await getDealMap(db, chatId);
  if (existing && existing.status === 'confirmed') {
    const snapshot = existing.attio_deal_id
      ? { record_id: existing.attio_deal_id, values: {} }
      : null;
    return fromRow(existing, snapshot);
  }

  // No title => nothing to fuzzy-match on; record unmatched.
  if (!chatTitle || !chatTitle.trim()) {
    await upsertDealMap(db, {
      chat_id: chatId,
      status: 'unmatched',
      confidence: 0,
      match_method: 'no_title',
      chat_title: chatTitle,
    });
    return {
      chat_id: chatId,
      status: 'unmatched',
      attio_deal_id: null,
      confidence: 0,
      match_method: 'no_title',
      candidates: [],
      deal_snapshot: null,
    };
  }

  // 2. Fuzzy match the chat title against Attio deal names.
  const autoConfirmScore = parseScore(env.DEAL_AUTO_CONFIRM_SCORE, DEFAULT_AUTO_CONFIRM_SCORE);
  const deals = await listDeals(env);

  const scored = deals
    .map((rec) => {
      const id = recordId(rec);
      const name = dealName(rec);
      if (!id || !name) return null;
      return { rec, id, name, score: titleSimilarity(chatTitle, name) };
    })
    .filter((x): x is { rec: AttioRecord; id: string; name: string; score: number } => x != null)
    .filter((x) => x.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // 3. Unmatched — persist so it surfaces for manual linking.
    await upsertDealMap(db, {
      chat_id: chatId,
      status: 'unmatched',
      confidence: 0,
      match_method: 'no_match',
      chat_title: chatTitle,
    });
    return {
      chat_id: chatId,
      status: 'unmatched',
      attio_deal_id: null,
      confidence: 0,
      match_method: 'no_match',
      candidates: [],
      deal_snapshot: null,
    };
  }

  const candidates: DealCandidate[] = scored.slice(0, 5).map((s) => ({
    attio_deal_id: s.id,
    confidence: round2(s.score),
    match_method: 'fuzzy_title',
    label: s.name,
    matched_on: { chat_title: chatTitle, deal_name: s.name },
  }));

  const top = scored[0]!;
  const margin = parseScore(env.DEAL_DISAMBIGUATION_MARGIN, DEFAULT_DISAMBIGUATION_MARGIN);
  // Hybrid policy: auto-confirm only a clear winner; otherwise leave as a
  // candidate for human confirmation in Notion (then remembered).
  const autoConfirm = isClearWinner(
    scored.map((s) => s.score),
    autoConfirmScore,
    margin
  );
  const status = autoConfirm ? 'confirmed' : 'candidate';

  await upsertDealMap(db, {
    chat_id: chatId,
    // A candidate is NOT a write target: leave attio_deal_id null unless confirmed.
    attio_deal_id: autoConfirm ? top.id : null,
    status,
    confidence: round2(top.score),
    match_method: 'fuzzy_title',
    candidates_json: candidates,
    chat_title: chatTitle,
  });

  return {
    chat_id: chatId,
    status,
    attio_deal_id: autoConfirm ? top.id : null,
    confidence: round2(top.score),
    match_method: 'fuzzy_title',
    candidates,
    deal_snapshot: autoConfirm ? { record_id: top.id, values: top.rec.values ?? {} } : null,
  };
}

function parseScore(raw: string | undefined, fallback: number): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
