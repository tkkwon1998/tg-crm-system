/**
 * @crm/db — shared types. Single source of truth for table row shapes,
 * status unions, and the Claude extraction contract (spec §6, §7).
 *
 * Conventions:
 * - All timestamps are unix epoch SECONDS (UTC) stored as INTEGER in D1.
 * - JSON columns are stored as TEXT; the *_json / *Json helpers parse them.
 * - Booleans are stored as INTEGER 0/1 in D1; row types expose them as 0 | 1.
 */

// ---------------------------------------------------------------------------
// Status string-literal unions (mirror the CHECK constraints in schema.sql)
// ---------------------------------------------------------------------------

/** identity_map.status */
export type IdentityStatus = 'unmatched' | 'candidate' | 'confirmed' | 'rejected';

/** deal_map.status (same lifecycle as identity resolution). */
export type DealStatus = 'unmatched' | 'candidate' | 'confirmed' | 'rejected';

/** crm_proposals.status */
export type ProposalStatus = 'pending' | 'approved' | 'applied' | 'rejected';

/** crm_proposals.suggested_action and the Claude output's suggested_action */
export type SuggestedAction = 'bump' | 'follow_up' | 'none';

/** Attio object slug a proposal targets. People is the default/primary object. */
export type AttioObject = 'people' | 'companies' | 'deals';

// ---------------------------------------------------------------------------
// telegram_messages
// ---------------------------------------------------------------------------

/** A row in telegram_messages (raw message log; PK (chat_id, message_id)). */
export interface Message {
  chat_id: number;
  message_id: number;
  sender_user_id: number | null;
  chat_title: string | null;
  text: string | null;
  /** message timestamp, unix epoch seconds (UTC) */
  msg_date: number;
  /** 0 | 1: was this message sent by the account owner */
  is_outgoing: 0 | 1;
  /** full raw message JSON (audit trail), stored as TEXT */
  raw_json: string;
  /** unix seconds when the extract pipeline processed it; null = un-extracted */
  extracted_at: number | null;
  /** unix seconds when this row was written to D1 */
  ingested_at: number;
}

/** Input shape for upserting a message (server-defaulted columns optional). */
export interface MessageInput {
  chat_id: number;
  message_id: number;
  sender_user_id?: number | null;
  chat_title?: string | null;
  text?: string | null;
  msg_date: number;
  is_outgoing?: boolean | 0 | 1;
  /** Either a JSON string or any serializable object (it will be JSON.stringify'd). */
  raw_json: string | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// chat_cursors
// ---------------------------------------------------------------------------

/** A row in chat_cursors (resume point for catch-up). */
export interface ChatCursor {
  chat_id: number;
  /** highest message_id ingested so far; the min_id for the next fetch */
  last_message_id: number;
  chat_title: string | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// identity_map
// ---------------------------------------------------------------------------

/** A row in identity_map (durable telegram_user_id <-> attio_record_id). */
export interface IdentityMatch {
  id: number;
  telegram_user_id: number;
  attio_record_id: string | null;
  status: IdentityStatus;
  /** 0.0–1.0 */
  confidence: number;
  /** e.g. 'phone_exact' | 'fuzzy_search' | 'manual' | 'seed' */
  match_method: string | null;
  /** JSON array of candidate matches (for review), stored as TEXT */
  candidates_json: string | null;
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

/** Input shape for upserting an identity (keyed on telegram_user_id). */
export interface IdentityInput {
  telegram_user_id: number;
  attio_record_id?: string | null;
  status: IdentityStatus;
  confidence?: number;
  match_method?: string | null;
  /** JSON string or serializable array of candidates. */
  candidates_json?: string | unknown[] | null;
  display_name?: string | null;
}

/** One candidate match stored inside identity_map.candidates_json. */
export interface IdentityCandidate {
  attio_record_id: string;
  confidence: number;
  match_method: string;
  /** optional human-readable label and matched attributes for review */
  label?: string;
  matched_on?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// deal_map
// ---------------------------------------------------------------------------

/** A row in deal_map (durable group chat_id <-> attio_deal_id). */
export interface DealMatch {
  chat_id: number;
  attio_deal_id: string | null;
  status: DealStatus;
  /** 0.0–1.0 */
  confidence: number;
  /** e.g. 'fuzzy_title' | 'manual' | 'seed' */
  match_method: string | null;
  /** JSON array of candidate deals (for review), stored as TEXT */
  candidates_json: string | null;
  chat_title: string | null;
  created_at: number;
  updated_at: number;
}

/** Input shape for upserting a deal mapping (keyed on chat_id). */
export interface DealInput {
  chat_id: number;
  attio_deal_id?: string | null;
  status: DealStatus;
  confidence?: number;
  match_method?: string | null;
  /** JSON string or serializable array of candidates. */
  candidates_json?: string | unknown[] | null;
  chat_title?: string | null;
}

/** One candidate deal stored inside deal_map.candidates_json. */
export interface DealCandidate {
  attio_deal_id: string;
  confidence: number;
  match_method: string;
  /** human-readable deal name + any matched fields for review */
  label?: string;
  matched_on?: Record<string, unknown>;
}

/** A resolved group participant carried on a deal proposal (associate as contact). */
export interface ProposalParticipant {
  telegram_user_id: number;
  /** resolved Attio person record id, or null if unmatched */
  attio_person_id: string | null;
  name: string | null;
  /** identity resolution status for this participant */
  status: IdentityStatus;
  /** optional role inferred from the thread (e.g. 'champion', 'decision_maker') */
  role?: string;
}

// ---------------------------------------------------------------------------
// crm_proposals
// ---------------------------------------------------------------------------

/** A row in crm_proposals (the review queue). */
export interface Proposal {
  id: number;
  telegram_user_id: number | null;
  /** originating group chat (deal-centric flow); null for legacy person proposals */
  telegram_chat_id: number | null;
  attio_object: AttioObject;
  attio_record_id: string | null;
  /** JSON object { "<attribute_slug>": <value> }, stored as TEXT */
  proposed_changes: string;
  /** JSON array of ProposalParticipant to associate with the deal, stored as TEXT */
  participants_json: string | null;
  suggested_action: SuggestedAction;
  /** 0.0–1.0 */
  confidence: number;
  rationale: string | null;
  /** JSON array of "<chat_id>:<message_id>" strings, stored as TEXT */
  source_message_ids: string;
  status: ProposalStatus;
  applied_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Input shape for inserting a proposal. */
export interface ProposalInput {
  telegram_user_id?: number | null;
  telegram_chat_id?: number | null;
  attio_object?: AttioObject;
  attio_record_id?: string | null;
  /** JSON string or a plain object of attribute_slug -> value. */
  proposed_changes: string | Record<string, unknown>;
  /** JSON string or array of ProposalParticipant to associate with the deal. */
  participants?: string | ProposalParticipant[] | null;
  suggested_action?: SuggestedAction;
  confidence?: number;
  rationale?: string | null;
  /** JSON string or array of "<chat_id>:<message_id>" strings. */
  source_message_ids: string | string[];
  /** Defaults to 'pending'. */
  status?: ProposalStatus;
}

// ---------------------------------------------------------------------------
// Claude extraction contract (spec §7)
// ---------------------------------------------------------------------------

/**
 * Strict JSON the extract Worker instructs Claude to emit (no prose).
 * Parse defensively against this shape; guardrails are enforced in code,
 * never by the model.
 */
export interface ClaudeExtraction {
  /** Attio object slug the change targets, e.g. "people". */
  attio_object: string;
  /** Matched Attio record id, or null when there is no confident match (never writes). */
  attio_record_id: string | null;
  /** Map of attribute slug -> proposed value. */
  proposed_changes: Record<string, unknown>;
  suggested_action: SuggestedAction;
  /** 0.0–1.0 */
  confidence: number;
  /** one line */
  rationale: string;
  /** array of "<chat_id>:<message_id>" strings */
  source_message_ids: string[];
  /**
   * Deal-centric flow only: participant roles the model inferred from the
   * thread (names as they appear in chat + optional role). Merged with the
   * deterministic sender->person resolution; advisory, not a write source.
   */
  participants?: Array<{ name: string; role?: string }>;
}
