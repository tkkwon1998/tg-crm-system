/**
 * @crm/db — typed D1 query helpers.
 *
 * Every function takes a D1Database (the Worker's bound `env.DB`) as its first
 * argument so the package stays stateless and bindable from any app. All writes
 * use prepared statements with bound parameters; all reads return the row types
 * declared in ./types.
 */

import type {
  ChatCursor,
  DealInput,
  DealMatch,
  DealStatus,
  IdentityInput,
  IdentityMatch,
  IdentityStatus,
  Message,
  MessageInput,
  Proposal,
  ProposalInput,
  ProposalStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

const now = (): number => Math.floor(Date.now() / 1000);

const toBit = (v: boolean | 0 | 1 | undefined): 0 | 1 =>
  v === true || v === 1 ? 1 : 0;

/** Coerce a value that may be an object/array or already a JSON string into TEXT. */
const toJsonText = (v: unknown): string =>
  typeof v === 'string' ? v : JSON.stringify(v ?? null);

// ===========================================================================
// telegram_messages
// ===========================================================================

/**
 * Idempotent upsert on the PK (chat_id, message_id). Re-running ingest never
 * duplicates a message; existing rows are refreshed with the latest payload
 * but extracted_at / ingested_at are preserved.
 */
export async function upsertMessage(db: D1Database, msg: MessageInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_messages
         (chat_id, message_id, sender_user_id, chat_title, text, msg_date, is_outgoing, raw_json, ingested_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET
         sender_user_id = excluded.sender_user_id,
         chat_title     = excluded.chat_title,
         text           = excluded.text,
         msg_date       = excluded.msg_date,
         is_outgoing    = excluded.is_outgoing,
         raw_json       = excluded.raw_json`
    )
    .bind(
      msg.chat_id,
      msg.message_id,
      msg.sender_user_id ?? null,
      msg.chat_title ?? null,
      msg.text ?? null,
      msg.msg_date,
      toBit(msg.is_outgoing),
      toJsonText(msg.raw_json),
      now()
    )
    .run();
}

/**
 * Idempotent batch upsert of many messages in a single D1 batch (one round-trip).
 * Returns the number of input rows.
 */
export async function upsertMessages(db: D1Database, msgs: MessageInput[]): Promise<number> {
  if (msgs.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO telegram_messages
       (chat_id, message_id, sender_user_id, chat_title, text, msg_date, is_outgoing, raw_json, ingested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (chat_id, message_id) DO UPDATE SET
       sender_user_id = excluded.sender_user_id,
       chat_title     = excluded.chat_title,
       text           = excluded.text,
       msg_date       = excluded.msg_date,
       is_outgoing    = excluded.is_outgoing,
       raw_json       = excluded.raw_json`
  );
  const ts = now();
  await db.batch(
    msgs.map((m) =>
      stmt.bind(
        m.chat_id,
        m.message_id,
        m.sender_user_id ?? null,
        m.chat_title ?? null,
        m.text ?? null,
        m.msg_date,
        toBit(m.is_outgoing),
        toJsonText(m.raw_json),
        ts
      )
    )
  );
  return msgs.length;
}

/** Messages not yet processed by the extract pipeline, oldest first. */
export async function getUnextractedMessages(db: D1Database, limit = 200): Promise<Message[]> {
  const res = await db
    .prepare(
      `SELECT * FROM telegram_messages
       WHERE extracted_at IS NULL
       ORDER BY msg_date ASC, chat_id ASC, message_id ASC
       LIMIT ?1`
    )
    .bind(limit)
    .all<Message>();
  return res.results ?? [];
}

/** Mark specific messages as extracted (idempotent; safe to re-run). */
export async function markMessagesExtracted(
  db: D1Database,
  keys: Array<{ chat_id: number; message_id: number }>
): Promise<void> {
  if (keys.length === 0) return;
  const ts = now();
  const stmt = db.prepare(
    `UPDATE telegram_messages SET extracted_at = ?1 WHERE chat_id = ?2 AND message_id = ?3`
  );
  await db.batch(keys.map((k) => stmt.bind(ts, k.chat_id, k.message_id)));
}

/** Newest message timestamp (unix seconds) across all chats; null if empty. Used by watchdog. */
export async function getNewestMessageDate(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT MAX(msg_date) AS newest FROM telegram_messages`)
    .first<{ newest: number | null }>();
  return row?.newest ?? null;
}

// ===========================================================================
// chat_cursors
// ===========================================================================

/** All cursors (the resume map handed to the ingest container). */
export async function getCursors(db: D1Database): Promise<ChatCursor[]> {
  const res = await db.prepare(`SELECT * FROM chat_cursors`).all<ChatCursor>();
  return res.results ?? [];
}

/** One cursor by chat_id, or null if the chat has never been seen. */
export async function getCursor(db: D1Database, chatId: number): Promise<ChatCursor | null> {
  return await db
    .prepare(`SELECT * FROM chat_cursors WHERE chat_id = ?1`)
    .bind(chatId)
    .first<ChatCursor>();
}

/**
 * Advance (or create) a chat's cursor. The cursor only ever moves forward:
 * MAX(existing, new) guards against out-of-order or stale writes.
 */
export async function setCursor(
  db: D1Database,
  chatId: number,
  lastMessageId: number,
  chatTitle?: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_cursors (chat_id, last_message_id, chat_title, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (chat_id) DO UPDATE SET
         last_message_id = MAX(chat_cursors.last_message_id, excluded.last_message_id),
         chat_title      = COALESCE(excluded.chat_title, chat_cursors.chat_title),
         updated_at      = excluded.updated_at`
    )
    .bind(chatId, lastMessageId, chatTitle ?? null, now())
    .run();
}

// ===========================================================================
// identity_map
// ===========================================================================

/** All confirmed identities (the trusted telegram_user_id -> attio_record_id map). */
export async function getConfirmed(db: D1Database): Promise<IdentityMatch[]> {
  const res = await db
    .prepare(`SELECT * FROM identity_map WHERE status = 'confirmed'`)
    .all<IdentityMatch>();
  return res.results ?? [];
}

/** One identity row by Telegram user id, or null. */
export async function getIdentity(
  db: D1Database,
  telegramUserId: number
): Promise<IdentityMatch | null> {
  return await db
    .prepare(`SELECT * FROM identity_map WHERE telegram_user_id = ?1`)
    .bind(telegramUserId)
    .first<IdentityMatch>();
}

/** Identities filtered by status (e.g. 'unmatched' for the review queue). */
export async function listIdentitiesByStatus(
  db: D1Database,
  status: IdentityStatus
): Promise<IdentityMatch[]> {
  const res = await db
    .prepare(`SELECT * FROM identity_map WHERE status = ?1 ORDER BY updated_at DESC`)
    .bind(status)
    .all<IdentityMatch>();
  return res.results ?? [];
}

/**
 * Upsert an identity keyed on telegram_user_id.
 * A `confirmed` row is never overwritten by a non-manual re-match: if the
 * existing status is 'confirmed', only an incoming 'confirmed'/'rejected'
 * (an explicit human decision) is allowed to change it.
 */
export async function upsertIdentity(db: D1Database, input: IdentityInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO identity_map
         (telegram_user_id, attio_record_id, status, confidence, match_method, candidates_json, display_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         attio_record_id = CASE
             WHEN identity_map.status = 'confirmed' AND excluded.status NOT IN ('confirmed','rejected')
               THEN identity_map.attio_record_id
             ELSE excluded.attio_record_id END,
         status = CASE
             WHEN identity_map.status = 'confirmed' AND excluded.status NOT IN ('confirmed','rejected')
               THEN identity_map.status
             ELSE excluded.status END,
         confidence = CASE
             WHEN identity_map.status = 'confirmed' AND excluded.status NOT IN ('confirmed','rejected')
               THEN identity_map.confidence
             ELSE excluded.confidence END,
         match_method    = COALESCE(excluded.match_method, identity_map.match_method),
         candidates_json = COALESCE(excluded.candidates_json, identity_map.candidates_json),
         display_name    = COALESCE(excluded.display_name, identity_map.display_name),
         updated_at      = excluded.updated_at`
    )
    .bind(
      input.telegram_user_id,
      input.attio_record_id ?? null,
      input.status,
      input.confidence ?? 0,
      input.match_method ?? null,
      input.candidates_json == null ? null : toJsonText(input.candidates_json),
      input.display_name ?? null,
      now()
    )
    .run();
}

/** Convenience: human/manual confirmation of a telegram_user_id -> attio_record_id link. */
export async function confirmIdentity(
  db: D1Database,
  telegramUserId: number,
  attioRecordId: string,
  matchMethod = 'manual'
): Promise<void> {
  await upsertIdentity(db, {
    telegram_user_id: telegramUserId,
    attio_record_id: attioRecordId,
    status: 'confirmed',
    confidence: 1,
    match_method: matchMethod,
  });
}

// ===========================================================================
// deal_map
// ===========================================================================

/** One deal mapping by chat_id, or null if the chat has never been resolved. */
export async function getDealMap(db: D1Database, chatId: number): Promise<DealMatch | null> {
  return await db
    .prepare(`SELECT * FROM deal_map WHERE chat_id = ?1`)
    .bind(chatId)
    .first<DealMatch>();
}

/** All confirmed chat -> deal mappings (the trusted set). */
export async function getConfirmedDeals(db: D1Database): Promise<DealMatch[]> {
  const res = await db
    .prepare(`SELECT * FROM deal_map WHERE status = 'confirmed'`)
    .all<DealMatch>();
  return res.results ?? [];
}

/** Deal mappings filtered by status (e.g. 'candidate'/'unmatched' for review). */
export async function listDealsByStatus(db: D1Database, status: DealStatus): Promise<DealMatch[]> {
  const res = await db
    .prepare(`SELECT * FROM deal_map WHERE status = ?1 ORDER BY updated_at DESC`)
    .bind(status)
    .all<DealMatch>();
  return res.results ?? [];
}

/**
 * Upsert a deal mapping keyed on chat_id. A `confirmed` row is never overwritten
 * by a non-manual re-match: only an incoming 'confirmed'/'rejected' (explicit
 * human decision) may change a confirmed mapping. Mirrors upsertIdentity.
 */
export async function upsertDealMap(db: D1Database, input: DealInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deal_map
         (chat_id, attio_deal_id, status, confidence, match_method, candidates_json, chat_title, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (chat_id) DO UPDATE SET
         attio_deal_id = CASE
             WHEN deal_map.status = 'confirmed' AND excluded.status NOT IN ('confirmed','rejected')
               THEN deal_map.attio_deal_id ELSE excluded.attio_deal_id END,
         status = CASE
             WHEN deal_map.status = 'confirmed' AND excluded.status NOT IN ('confirmed','rejected')
               THEN deal_map.status ELSE excluded.status END,
         confidence = CASE
             WHEN deal_map.status = 'confirmed' AND excluded.status NOT IN ('confirmed','rejected')
               THEN deal_map.confidence ELSE excluded.confidence END,
         match_method    = COALESCE(excluded.match_method, deal_map.match_method),
         candidates_json = COALESCE(excluded.candidates_json, deal_map.candidates_json),
         chat_title      = COALESCE(excluded.chat_title, deal_map.chat_title),
         updated_at      = excluded.updated_at`
    )
    .bind(
      input.chat_id,
      input.attio_deal_id ?? null,
      input.status,
      input.confidence ?? 0,
      input.match_method ?? null,
      input.candidates_json == null ? null : toJsonText(input.candidates_json),
      input.chat_title ?? null,
      now()
    )
    .run();
}

// ===========================================================================
// crm_proposals
// ===========================================================================

/** Insert a new proposal (defaults status='pending'); returns the new row id. */
export async function insertProposal(db: D1Database, input: ProposalInput): Promise<number> {
  const ts = now();
  const res = await db
    .prepare(
      `INSERT INTO crm_proposals
         (telegram_user_id, telegram_chat_id, attio_object, attio_record_id, proposed_changes,
          participants_json, suggested_action, confidence, rationale, source_message_ids,
          status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       RETURNING id`
    )
    .bind(
      input.telegram_user_id ?? null,
      input.telegram_chat_id ?? null,
      input.attio_object ?? 'people',
      input.attio_record_id ?? null,
      toJsonText(input.proposed_changes),
      input.participants == null ? null : toJsonText(input.participants),
      input.suggested_action ?? 'none',
      input.confidence ?? 0,
      input.rationale ?? null,
      toJsonText(input.source_message_ids),
      input.status ?? 'pending',
      ts
    )
    .first<{ id: number }>();
  return res!.id;
}

/** Pending proposals (the review queue), oldest first. */
export async function getPending(db: D1Database, limit = 200): Promise<Proposal[]> {
  const res = await db
    .prepare(
      `SELECT * FROM crm_proposals WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?1`
    )
    .bind(limit)
    .all<Proposal>();
  return res.results ?? [];
}

/** Proposals filtered by an arbitrary status (e.g. 'approved' for the apply Worker). */
export async function listByStatus(
  db: D1Database,
  status: ProposalStatus,
  limit = 200
): Promise<Proposal[]> {
  const res = await db
    .prepare(
      `SELECT * FROM crm_proposals WHERE status = ?1 ORDER BY created_at ASC LIMIT ?2`
    )
    .bind(status, limit)
    .all<Proposal>();
  return res.results ?? [];
}

/** One proposal by id, or null. */
export async function getProposal(db: D1Database, id: number): Promise<Proposal | null> {
  return await db
    .prepare(`SELECT * FROM crm_proposals WHERE id = ?1`)
    .bind(id)
    .first<Proposal>();
}

/**
 * Transition a proposal's status. When moving to 'applied', applied_at is set;
 * an optional error string is stored (and cleared on success).
 */
export async function markStatus(
  db: D1Database,
  id: number,
  status: ProposalStatus,
  error: string | null = null
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `UPDATE crm_proposals SET
         status     = ?2,
         applied_at = CASE WHEN ?2 = 'applied' THEN ?3 ELSE applied_at END,
         error      = ?4,
         updated_at = ?3
       WHERE id = ?1`
    )
    .bind(id, status, ts, error)
    .run();
}

/** Count proposals grouped by status (watchdog queue-depth check / dashboard). */
export async function countByStatus(db: D1Database): Promise<Record<ProposalStatus, number>> {
  const res = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM crm_proposals GROUP BY status`)
    .all<{ status: ProposalStatus; n: number }>();
  const out: Record<ProposalStatus, number> = {
    pending: 0,
    approved: 0,
    applied: 0,
    rejected: 0,
  };
  for (const r of res.results ?? []) out[r.status] = r.n;
  return out;
}
