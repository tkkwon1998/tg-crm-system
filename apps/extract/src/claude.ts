/**
 * Claude extraction (spec §5.2, §7).
 *
 * Calls the Anthropic Messages API (https://api.anthropic.com/v1/messages) and
 * instructs the model to emit ONLY strict JSON matching the ClaudeExtraction
 * contract from @crm/db. We parse defensively — guardrails are enforced in code
 * (see workflow.ts), never trusted from the model output.
 *
 * Model policy (contract note 4):
 *   default  claude-haiku-4-5-20251001  (cost at volume)
 *   escalate claude-sonnet-4-6          (long threads OR low first-pass confidence)
 */

import type { ClaudeExtraction, SuggestedAction } from '@crm/db';
import type { Env, ThreadMessage } from './env.js';
import type { ResolvedIdentity } from './identity.js';

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
export const MODEL_SONNET = 'claude-sonnet-4-6';

/** Threads with more than this many messages escalate to Sonnet up front. */
const LONG_THREAD_MESSAGE_COUNT = 25;
/** Total thread text longer than this (chars) escalates to Sonnet up front. */
const LONG_THREAD_CHARS = 12_000;
/** First-pass (Haiku) confidence at/below which we re-run on Sonnet. */
const LOW_CONFIDENCE_THRESHOLD = 0.45;

const SUGGESTED_ACTIONS: readonly SuggestedAction[] = ['bump', 'follow_up', 'none'];

const SYSTEM_PROMPT = `You are a CRM data-extraction assistant for a B2B sales team. You read a thread of Telegram messages between a salesperson (the "owner") and a counterparty, plus a snapshot of the counterparty's current Attio CRM record, and you propose structured CRM updates.

Output ONLY a single JSON object and nothing else — no prose, no markdown fences, no explanation. The JSON MUST match this exact shape:

{
  "attio_object": "people",
  "attio_record_id": "rec_... or null",
  "proposed_changes": { "<attribute_slug>": <value> },
  "suggested_action": "bump" | "follow_up" | "none",
  "confidence": 0.0,
  "rationale": "one short line",
  "source_message_ids": ["<chat_id>:<message_id>", ...]
}

Rules:
- attio_record_id: echo the provided record_id if (and only if) the snapshot clearly belongs to this counterparty; otherwise null. Never invent a record id.
- proposed_changes: ONLY include attributes you have direct evidence for in the messages (e.g. a phone number, an email, a job title the person stated). Use the Attio attribute slug as the key. If you have no confident change, return an empty object {}.
- Do NOT propose deal-stage changes or creating new records; those are out of scope for this extraction.
- suggested_action: "bump" if the salesperson should re-engage a dormant/waiting thread, "follow_up" if there is an open commitment to act on, "none" otherwise.
- confidence: your honest 0.0-1.0 confidence in the overall proposal.
- source_message_ids: the "<chat_id>:<message_id>" of the messages that justify your proposal. Only include ids present in the input.
- Never include attributes or values that are not supported by the message text.`;

export interface ExtractionResult {
  extraction: ClaudeExtraction;
  model: string;
  /** Whether a Sonnet escalation pass was performed. */
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// prompt assembly
// ---------------------------------------------------------------------------

function renderThread(messages: ThreadMessage[]): string {
  return messages
    .map((m) => {
      const who = m.is_outgoing === 1 ? 'OWNER' : 'COUNTERPARTY';
      const when = new Date(m.msg_date * 1000).toISOString();
      const id = `${m.chat_id}:${m.message_id}`;
      const text = m.text ?? '(no text / non-text message)';
      return `[${id}] (${when}) ${who}: ${text}`;
    })
    .join('\n');
}

function buildUserMessage(
  identity: ResolvedIdentity,
  chatTitle: string | null,
  messages: ThreadMessage[]
): string {
  const snapshot = identity.attio_snapshot
    ? JSON.stringify(identity.attio_snapshot, null, 2)
    : 'null (no confident Attio match — propose changes but leave attio_record_id null)';

  return [
    `CHAT TITLE: ${chatTitle ?? '(none)'}`,
    `RESOLVED IDENTITY STATUS: ${identity.status}`,
    `ATTIO RECORD SNAPSHOT:`,
    snapshot,
    ``,
    `MESSAGE THREAD (oldest first):`,
    renderThread(messages),
    ``,
    `Return the JSON object now.`,
  ].join('\n');
}

function totalChars(messages: ThreadMessage[]): number {
  return messages.reduce((n, m) => n + (m.text?.length ?? 0), 0);
}

// ---------------------------------------------------------------------------
// defensive JSON parsing
// ---------------------------------------------------------------------------

/** Pull the first balanced top-level JSON object out of arbitrary model text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function coerceAction(v: unknown): SuggestedAction {
  return SUGGESTED_ACTIONS.includes(v as SuggestedAction)
    ? (v as SuggestedAction)
    : 'none';
}

function coerceSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Parse the model's raw text into a normalized ClaudeExtraction. Always returns
 * a well-formed object; on unparseable output returns a zero-confidence,
 * no-op extraction (which the workflow will route to human review).
 */
export function parseExtraction(raw: string): ClaudeExtraction {
  const fallback: ClaudeExtraction = {
    attio_object: 'people',
    attio_record_id: null,
    proposed_changes: {},
    suggested_action: 'none',
    confidence: 0,
    rationale: 'unparseable model output',
    source_message_ids: [],
  };

  const jsonText = extractJsonObject(raw);
  if (!jsonText) return fallback;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    obj = parsed as Record<string, unknown>;
  } catch {
    return fallback;
  }

  const changes =
    obj.proposed_changes &&
    typeof obj.proposed_changes === 'object' &&
    !Array.isArray(obj.proposed_changes)
      ? (obj.proposed_changes as Record<string, unknown>)
      : {};

  const recId = obj.attio_record_id;
  return {
    attio_object: typeof obj.attio_object === 'string' ? obj.attio_object : 'people',
    attio_record_id: typeof recId === 'string' && recId.length > 0 ? recId : null,
    proposed_changes: changes,
    suggested_action: coerceAction(obj.suggested_action),
    confidence: clampConfidence(obj.confidence),
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    source_message_ids: coerceSourceIds(obj.source_message_ids),
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

async function callMessages(
  env: Env,
  model: string,
  userMessage: string
): Promise<string> {
  const base = (env.ANTHROPIC_API_BASE || DEFAULT_ANTHROPIC_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return text;
}

/**
 * Run extraction for a thread. Chooses Haiku by default; escalates to Sonnet
 * when the thread is long, or re-runs on Sonnet when the Haiku pass returns
 * low confidence. Output is parsed defensively into a ClaudeExtraction.
 */
export async function extractFromThread(
  env: Env,
  identity: ResolvedIdentity,
  chatTitle: string | null,
  messages: ThreadMessage[]
): Promise<ExtractionResult> {
  const userMessage = buildUserMessage(identity, chatTitle, messages);

  const longThread =
    messages.length > LONG_THREAD_MESSAGE_COUNT ||
    totalChars(messages) > LONG_THREAD_CHARS;

  // Long threads go straight to Sonnet (single pass).
  if (longThread) {
    const raw = await callMessages(env, MODEL_SONNET, userMessage);
    return { extraction: parseExtraction(raw), model: MODEL_SONNET, escalated: true };
  }

  // First pass on Haiku.
  const haikuRaw = await callMessages(env, MODEL_HAIKU, userMessage);
  const haiku = parseExtraction(haikuRaw);

  // Escalate to Sonnet when first-pass confidence is low.
  if (haiku.confidence <= LOW_CONFIDENCE_THRESHOLD) {
    const sonnetRaw = await callMessages(env, MODEL_SONNET, userMessage);
    return { extraction: parseExtraction(sonnetRaw), model: MODEL_SONNET, escalated: true };
  }

  return { extraction: haiku, model: MODEL_HAIKU, escalated: false };
}
