/**
 * sync Worker — deal-centric review surface (spec §5.3, deal model).
 *
 * Projects D1 state into the Notion "Telegram Deal Chats" database: one row per
 * group chat (the deal_map universe), showing whether it's matched/candidate/
 * unmatched to an Attio deal, the candidate options, the latest thread summary,
 * resolved participants, and a copy-paste `make link-deal` command so a human
 * can confirm an ambiguous match from the terminal (the hybrid model's
 * confirmation loop).
 *
 * Invariants: DIFFS ONLY (only POST/PATCH when something changed) and every
 * Notion call goes through NotionClient's serialized ~3 req/s gate.
 */

import {
  listAllDeals,
  getDealProposals,
  type DealCandidate,
  type DealMatch,
  type DealStatus,
  type Proposal,
  type ProposalParticipant,
  type SuggestedAction,
} from '@crm/db';

import {
  NotionClient,
  type NotionPage,
  type NotionProperties,
  title,
  richText,
  select,
  numberProp,
  url,
  dateFromUnix,
  readText,
  readSelect,
  readNumber,
  readUrl,
  readDate,
} from './notion.js';

export interface Env {
  DB: D1Database;
  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
  NOTION_VERSION: string;
  MAX_DEALS_PER_RUN: string;
  NOTION_MIN_REQUEST_INTERVAL_MS: string;
}

// Notion property names — must match the "Telegram Deal Chats" database exactly.
// "Telegram Chat ID" is the stable join key between D1 deal_map and Notion.
const PROP = {
  chat: 'Chat',
  chatId: 'Telegram Chat ID',
  matchStatus: 'Match Status',
  topDeal: 'Top Deal',
  attioDeal: 'Attio Deal',
  candidates: 'Candidates',
  suggestedAction: 'Suggested Action',
  summary: 'Summary',
  participants: 'Participants',
  lastActivity: 'Last Activity',
  confidence: 'Confidence',
  confirmCommand: 'Confirm Command',
} as const;

const DEAL_URL = (recordId: string): string =>
  `https://app.attio.com/_/objects/deals/records/${recordId}`;

const SUGGESTED_ACTION_LABEL: Record<SuggestedAction, string> = {
  bump: 'Bump',
  follow_up: 'Follow up',
  none: 'No action',
};

// ---------------------------------------------------------------------------
// projection model
// ---------------------------------------------------------------------------

interface DealRow {
  chatId: number;
  chat: string;
  matchStatus: DealStatus;
  topDealName: string | null;
  attioDealId: string | null;
  candidates: DealCandidate[];
  suggestedAction: SuggestedAction;
  summary: string;
  participants: ProposalParticipant[];
  lastActivity: number | null;
  confidence: number;
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Build the desired row set from D1: every deal_map row joined to its latest proposal. */
async function buildDealRows(db: D1Database): Promise<DealRow[]> {
  const deals = await listAllDeals(db);
  const proposals = await getDealProposals(db); // newest-first

  // Latest proposal per chat (proposals are ordered created_at DESC).
  const latestByChat = new Map<number, Proposal>();
  for (const p of proposals) {
    if (p.telegram_chat_id == null) continue;
    if (!latestByChat.has(p.telegram_chat_id)) latestByChat.set(p.telegram_chat_id, p);
  }

  return deals.map((d) => projectRow(d, latestByChat.get(d.chat_id)));
}

function projectRow(deal: DealMatch, prop: Proposal | undefined): DealRow {
  const candidates = parseJsonArray<DealCandidate>(deal.candidates_json);
  // Top deal name: the confirmed candidate's label, else the highest candidate.
  const topDealName =
    (deal.attio_deal_id
      ? candidates.find((c) => c.attio_deal_id === deal.attio_deal_id)?.label
      : candidates[0]?.label) ?? null;

  return {
    chatId: deal.chat_id,
    chat: deal.chat_title?.trim() || `Chat ${deal.chat_id}`,
    matchStatus: deal.status,
    topDealName,
    attioDealId: deal.attio_deal_id,
    candidates,
    suggestedAction: prop?.suggested_action ?? 'none',
    summary: prop?.rationale?.trim() || '(no summary yet)',
    participants: prop ? parseJsonArray<ProposalParticipant>(prop.participants_json) : [],
    lastActivity: prop?.created_at ?? deal.updated_at,
    confidence: deal.confidence,
  };
}

function formatCandidates(cands: DealCandidate[]): string {
  if (cands.length === 0) return '';
  return cands
    .map((c) => `${c.label ?? '(deal)'} [${c.attio_deal_id}] ${Math.round(c.confidence * 100)}%`)
    .join(' · ');
}

function formatParticipants(ps: ProposalParticipant[]): string {
  if (ps.length === 0) return '';
  const named = ps.map((p) => p.name?.trim() || `tg:${p.telegram_user_id}`);
  const confirmed = ps.filter((p) => p.attio_person_id).length;
  return `${ps.length} participant(s)${confirmed ? `, ${confirmed} linked` : ''}: ${named.join(', ')}`;
}

/** The terminal command an operator runs to confirm/relink this chat's deal. */
function confirmCommand(row: DealRow): string {
  if (row.matchStatus === 'confirmed') return '✓ confirmed';
  const dealId = row.candidates[0]?.attio_deal_id ?? '<attio_deal_id>';
  return `make link-deal CHAT=${row.chatId} DEAL=${dealId}`;
}

// ---------------------------------------------------------------------------
// desired Notion properties + diffing
// ---------------------------------------------------------------------------

function desiredProperties(row: DealRow): NotionProperties {
  return {
    [PROP.chat]: title(row.chat),
    [PROP.chatId]: numberProp(row.chatId),
    [PROP.matchStatus]: select(row.matchStatus),
    [PROP.topDeal]: richText(row.topDealName ?? ''),
    [PROP.attioDeal]: url(row.attioDealId ? DEAL_URL(row.attioDealId) : null),
    [PROP.candidates]: richText(formatCandidates(row.candidates)),
    [PROP.suggestedAction]: select(SUGGESTED_ACTION_LABEL[row.suggestedAction]),
    [PROP.summary]: richText(row.summary),
    [PROP.participants]: richText(formatParticipants(row.participants)),
    [PROP.lastActivity]: dateFromUnix(row.lastActivity),
    [PROP.confidence]: numberProp(Math.round(row.confidence * 100) / 100),
    [PROP.confirmCommand]: richText(confirmCommand(row)),
  };
}

function sameDate(existingIso: string, desiredSec: number | null): boolean {
  const desiredIso = desiredSec == null ? '' : new Date(desiredSec * 1000).toISOString();
  return existingIso === desiredIso;
}

/** True when the existing Notion page already matches the desired row (skip write). */
function pageMatches(existing: NotionPage, row: DealRow): boolean {
  const p = existing.properties;
  if (readText(p[PROP.chat]) !== row.chat) return false;
  if (readSelect(p[PROP.matchStatus]) !== row.matchStatus) return false;
  if (readText(p[PROP.topDeal]) !== (row.topDealName ?? '')) return false;
  if (readUrl(p[PROP.attioDeal]) !== (row.attioDealId ? DEAL_URL(row.attioDealId) : '')) return false;
  if (readText(p[PROP.candidates]) !== formatCandidates(row.candidates)) return false;
  if (readSelect(p[PROP.suggestedAction]) !== SUGGESTED_ACTION_LABEL[row.suggestedAction]) return false;
  if (readText(p[PROP.summary]) !== row.summary) return false;
  if (readText(p[PROP.participants]) !== formatParticipants(row.participants)) return false;
  if (!sameDate(readDate(p[PROP.lastActivity]), row.lastActivity)) return false;
  if (readNumber(p[PROP.confidence]) !== Math.round(row.confidence * 100) / 100) return false;
  if (readText(p[PROP.confirmCommand]) !== confirmCommand(row)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface SyncResult {
  deals: number;
  created: number;
  updated: number;
  unchanged: number;
}

export async function runSync(env: Env): Promise<SyncResult> {
  const maxDeals = Math.max(1, Number(env.MAX_DEALS_PER_RUN) || 200);
  const minInterval = Math.max(0, Number(env.NOTION_MIN_REQUEST_INTERVAL_MS) || 350);

  const notion = new NotionClient({
    token: env.NOTION_TOKEN,
    version: env.NOTION_VERSION || '2022-06-28',
    minIntervalMs: minInterval,
  });

  let rows = await buildDealRows(env.DB);
  if (rows.length > maxDeals) rows = rows.slice(0, maxDeals);

  const existingPages = await notion.queryDatabaseAll(env.NOTION_DATABASE_ID);
  const pageByChat = new Map<number, NotionPage>();
  for (const page of existingPages) {
    const cid = readNumber(page.properties[PROP.chatId]);
    if (cid != null) pageByChat.set(cid, page);
  }

  const result: SyncResult = { deals: rows.length, created: 0, updated: 0, unchanged: 0 };
  for (const row of rows) {
    const existing = pageByChat.get(row.chatId);
    if (!existing) {
      await notion.createPage(env.NOTION_DATABASE_ID, desiredProperties(row));
      result.created += 1;
    } else if (!pageMatches(existing, row)) {
      await notion.updatePage(existing.id, desiredProperties(row));
      result.updated += 1;
    } else {
      result.unchanged += 1;
    }
  }
  return result;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const r = await runSync(env);
        console.log(`sync: deals=${r.deals} created=${r.created} updated=${r.updated} unchanged=${r.unchanged}`);
      })()
    );
  },

  // Manual trigger: `curl -X POST <worker-url>` to force a sync without waiting for cron.
  async fetch(_req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const r = await runSync(env);
      return Response.json({ ok: true, ...r });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('sync failed:', message);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  },
};
