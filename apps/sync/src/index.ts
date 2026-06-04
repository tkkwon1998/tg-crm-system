/**
 * sync Worker (spec §5.3).
 *
 * Projects the current CRM state into the Notion *action database*: one row per
 * active contact carrying last-contact time, a short thread summary, the
 * suggested action, an Attio link, and the identity resolution status. This is
 * the only human surface — Claude Cowork + the team read it from Notion.
 *
 * State is read exclusively through the @crm/db client (confirmed identities +
 * recent proposals). We NEVER re-implement table SQL here.
 *
 * Two invariants:
 *  - DIFFS ONLY. We read the existing Notion rows, compute the desired property
 *    set per contact, and only POST/PATCH when something actually changed.
 *  - RATE LIMIT. Every Notion request goes through NotionClient's serialized,
 *    spaced gate (~3 req/s), so a cron run can never burst past Notion's limit.
 */

import {
  getConfirmed,
  listByStatus,
  type IdentityMatch,
  type Proposal,
  type ProposalStatus,
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
  // secret
  NOTION_TOKEN: string;
  // vars (wrangler.jsonc)
  NOTION_DATABASE_ID: string;
  NOTION_VERSION: string;
  ACTIVE_WINDOW_DAYS: string;
  MAX_CONTACTS_PER_RUN: string;
  NOTION_MIN_REQUEST_INTERVAL_MS: string;
}

// ---------------------------------------------------------------------------
// Notion property names. These are the column titles in the action database.
// The Telegram User ID column is the stable join key between D1 and Notion.
// ---------------------------------------------------------------------------
const PROP = {
  name: 'Name',
  telegramUserId: 'Telegram User ID',
  lastContact: 'Last Contact',
  summary: 'Thread Summary',
  suggestedAction: 'Suggested Action',
  attioLink: 'Attio Link',
  resolutionStatus: 'Resolution Status',
  confidence: 'Confidence',
} as const;

const ATTIO_RECORD_URL = (recordId: string): string =>
  `https://app.attio.com/_/objects/people/records/${recordId}`;

const SUGGESTED_ACTION_LABEL: Record<SuggestedAction, string> = {
  bump: 'Bump',
  follow_up: 'Follow up',
  none: 'No action',
};

// Proposal statuses we consider "live" signal when projecting a contact.
// Applied proposals are history; rejected ones are noise. Pending/approved are
// the actionable queue, so they drive the suggested action shown in Notion.
const LIVE_PROPOSAL_STATUSES: ProposalStatus[] = ['pending', 'approved'];

// ---------------------------------------------------------------------------
// projection model
// ---------------------------------------------------------------------------

/** One desired Notion row, fully derived from D1 state. */
interface ContactRow {
  telegramUserId: number;
  name: string;
  attioRecordId: string | null;
  resolutionStatus: string;
  /** unix seconds of the most recent activity we can attribute to this contact */
  lastContact: number | null;
  summary: string;
  suggestedAction: SuggestedAction;
  confidence: number | null;
}

/**
 * Parse "<chat_id>:<message_id>" provenance strings. We can't read message
 * timestamps via the client without per-id SQL, so "last contact" is derived
 * from the most recent proposal that referenced the contact (proposals are
 * created as messages are extracted, so proposal recency tracks activity).
 */
function parseSourceCount(raw: string): number {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Build the desired set of contact rows from D1 state.
 *
 * Universe of contacts = confirmed identities (the trusted set) plus any
 * telegram_user_id that appears on a live proposal (so unmatched-but-active
 * people still surface for manual linking). A contact is "active" if it has a
 * live proposal within the active window.
 */
async function buildContactRows(db: D1Database, activeWindowSec: number): Promise<ContactRow[]> {
  const nowSec = Math.floor(Date.now() / 1000);

  const confirmed = await getConfirmed(db);
  const confirmedByUser = new Map<number, IdentityMatch>();
  for (const id of confirmed) confirmedByUser.set(id.telegram_user_id, id);

  // Gather live proposals (pending + approved), newest first per contact.
  const liveProposals: Proposal[] = [];
  for (const status of LIVE_PROPOSAL_STATUSES) {
    liveProposals.push(...(await listByStatus(db, status, 500)));
  }

  // Latest live proposal per telegram_user_id (created_at desc wins).
  const latestProposal = new Map<number, Proposal>();
  for (const p of liveProposals) {
    if (p.telegram_user_id == null) continue;
    const existing = latestProposal.get(p.telegram_user_id);
    if (!existing || p.created_at > existing.created_at) {
      latestProposal.set(p.telegram_user_id, p);
    }
  }

  const cutoff = nowSec - activeWindowSec;
  const rows = new Map<number, ContactRow>();

  // Seed from confirmed identities that have recent activity.
  for (const [userId, identity] of confirmedByUser) {
    const prop = latestProposal.get(userId);
    if (!prop || prop.created_at < cutoff) continue; // not active in window
    rows.set(userId, projectRow(userId, identity, prop));
  }

  // Add any contact with a live, in-window proposal even if not confirmed
  // (unmatched/candidate) so it shows up for manual linking.
  for (const [userId, prop] of latestProposal) {
    if (prop.created_at < cutoff) continue;
    if (rows.has(userId)) continue;
    rows.set(userId, projectRow(userId, confirmedByUser.get(userId) ?? null, prop));
  }

  // Newest activity first.
  return [...rows.values()].sort(
    (a, b) => (b.lastContact ?? 0) - (a.lastContact ?? 0)
  );
}

function projectRow(
  userId: number,
  identity: IdentityMatch | null,
  prop: Proposal
): ContactRow {
  const attioRecordId = identity?.attio_record_id ?? prop.attio_record_id ?? null;
  const resolutionStatus = identity?.status ?? 'unmatched';
  const name =
    identity?.display_name?.trim() ||
    `Telegram user ${userId}`;

  const sources = parseSourceCount(prop.source_message_ids);
  const rationale = prop.rationale?.trim() || 'No summary available.';
  const summary =
    sources > 0
      ? `${rationale} (from ${sources} message${sources === 1 ? '' : 's'})`
      : rationale;

  return {
    telegramUserId: userId,
    name,
    attioRecordId,
    resolutionStatus,
    // Proposal creation time is our best available proxy for recent contact.
    lastContact: prop.created_at,
    summary,
    suggestedAction: prop.suggested_action,
    confidence: prop.confidence,
  };
}

// ---------------------------------------------------------------------------
// desired Notion property set for a contact row
// ---------------------------------------------------------------------------

function desiredProperties(row: ContactRow): NotionProperties {
  return {
    [PROP.name]: title(row.name),
    [PROP.telegramUserId]: numberProp(row.telegramUserId),
    [PROP.lastContact]: dateFromUnix(row.lastContact),
    [PROP.summary]: richText(row.summary),
    [PROP.suggestedAction]: select(SUGGESTED_ACTION_LABEL[row.suggestedAction]),
    [PROP.attioLink]: url(row.attioRecordId ? ATTIO_RECORD_URL(row.attioRecordId) : null),
    [PROP.resolutionStatus]: select(row.resolutionStatus),
    [PROP.confidence]: numberProp(
      row.confidence == null ? null : Math.round(row.confidence * 100) / 100
    ),
  };
}

/** Date-equality at second granularity (both sides reduced to ISO of the unix sec). */
function sameDate(existingIso: string, desiredSec: number | null): boolean {
  const desiredIso = desiredSec == null ? '' : new Date(desiredSec * 1000).toISOString();
  return existingIso === desiredIso;
}

/**
 * Decide whether the existing Notion page already matches the desired row.
 * Returns true when NOTHING changed (so we can skip the write — diffs only).
 */
function pageMatches(existing: NotionPage, row: ContactRow): boolean {
  const p = existing.properties;
  if (readText(p[PROP.name]) !== row.name) return false;
  if (readText(p[PROP.summary]) !== row.summary) return false;
  if (readSelect(p[PROP.suggestedAction]) !== SUGGESTED_ACTION_LABEL[row.suggestedAction])
    return false;
  if (readSelect(p[PROP.resolutionStatus]) !== row.resolutionStatus) return false;

  const desiredUrl = row.attioRecordId ? ATTIO_RECORD_URL(row.attioRecordId) : '';
  if (readUrl(p[PROP.attioLink]) !== desiredUrl) return false;

  if (!sameDate(readDate(p[PROP.lastContact]), row.lastContact)) return false;

  const desiredConf = row.confidence == null ? null : Math.round(row.confidence * 100) / 100;
  if (readNumber(p[PROP.confidence]) !== desiredConf) return false;

  return true;
}

// ---------------------------------------------------------------------------
// the sync run
// ---------------------------------------------------------------------------

interface SyncResult {
  active: number;
  created: number;
  updated: number;
  unchanged: number;
}

export async function runSync(env: Env): Promise<SyncResult> {
  const activeWindowSec = Math.max(1, Number(env.ACTIVE_WINDOW_DAYS) || 30) * 86400;
  const maxContacts = Math.max(1, Number(env.MAX_CONTACTS_PER_RUN) || 100);
  const minInterval = Math.max(0, Number(env.NOTION_MIN_REQUEST_INTERVAL_MS) || 350);

  const notion = new NotionClient({
    token: env.NOTION_TOKEN,
    version: env.NOTION_VERSION || '2022-06-28',
    minIntervalMs: minInterval,
  });

  // 1. Desired state from D1.
  let rows = await buildContactRows(env.DB, activeWindowSec);
  if (rows.length > maxContacts) rows = rows.slice(0, maxContacts);

  // 2. Current Notion rows, indexed by the Telegram User ID join key.
  const existingPages = await notion.queryDatabaseAll(env.NOTION_DATABASE_ID);
  const pageByUser = new Map<number, NotionPage>();
  for (const page of existingPages) {
    const uid = readNumber(page.properties[PROP.telegramUserId]);
    if (uid != null) pageByUser.set(uid, page);
  }

  // 3. Diff & write.
  const result: SyncResult = { active: rows.length, created: 0, updated: 0, unchanged: 0 };
  for (const row of rows) {
    const existing = pageByUser.get(row.telegramUserId);
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

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const r = await runSync(env);
        console.log(
          `sync: active=${r.active} created=${r.created} updated=${r.updated} unchanged=${r.unchanged}`
        );
      })()
    );
  },

  // Manual trigger for terminal-only ops: `curl <worker-url>` to force a sync
  // (e.g. after seeding identities) without waiting for the cron.
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
