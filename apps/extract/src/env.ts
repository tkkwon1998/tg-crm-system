/**
 * Bindings & secrets for the extract app.
 *
 * Binding names are fixed by the frozen interface contract:
 *  - DB                -> shared D1 database "crm"
 *  - EXTRACT_WORKFLOW  -> the durable per-thread pipeline (ExtractWorkflow)
 *
 * Secrets (set via `wrangler secret put` or .dev.vars):
 *  - ANTHROPIC_API_KEY -> Claude Messages API
 *  - ATTIO_TOKEN       -> Attio REST API (identity resolution)
 *
 * Optional non-secret tuning vars (wrangler.jsonc "vars", all optional):
 *  - ATTIO_API_BASE, ANTHROPIC_API_BASE, AUTO_APPLY_THRESHOLD,
 *    PHONE_AUTO_CONFIRM, EXTRACT_BATCH_LIMIT
 */
export interface Env {
  DB: D1Database;
  EXTRACT_WORKFLOW: Workflow<ThreadWorkflowParams>;

  ANTHROPIC_API_KEY: string;
  ATTIO_TOKEN: string;

  // Optional overrides (strings because Worker vars are always strings).
  ATTIO_API_BASE?: string;
  ANTHROPIC_API_BASE?: string;
  AUTO_APPLY_THRESHOLD?: string;
  PHONE_AUTO_CONFIRM?: string;
  EXTRACT_BATCH_LIMIT?: string;
  /** Deal-centric flow: fuzzy chat-title->deal score at/above which to auto-confirm. */
  DEAL_AUTO_CONFIRM_SCORE?: string;
}

/** One message as carried into the Workflow payload (a trimmed Message). */
export interface ThreadMessage {
  chat_id: number;
  message_id: number;
  sender_user_id: number | null;
  chat_title: string | null;
  text: string | null;
  msg_date: number;
  is_outgoing: 0 | 1;
}

/**
 * Params handed to one Workflow instance: a single GROUP chat thread's worth of
 * un-extracted messages. Deal-centric: the whole chat maps to one Attio deal,
 * and the distinct senders become participants. Must be JSON-serializable.
 */
export interface ThreadWorkflowParams {
  chat_id: number;
  chat_title: string | null;
  messages: ThreadMessage[];
}
