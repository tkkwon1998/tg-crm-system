/**
 * Claude extraction — deal-centric (group chat -> Attio deal).
 *
 * Calls the Anthropic Messages API and instructs the model to read a GROUP
 * thread (plus the matched deal snapshot + resolved participants) and emit ONLY
 * strict JSON matching the ClaudeExtraction contract from @crm/db, targeting the
 * DEAL. We parse defensively; guardrails are enforced in code (workflow.ts) —
 * never trusted from the model.
 *
 * Model policy: default claude-haiku-4-5-20251001; escalate to
 * claude-sonnet-4-6 for long threads or low first-pass confidence.
 */

import type { ClaudeExtraction, ProposalParticipant, SuggestedAction } from '@crm/db';
import type { Env, ThreadMessage } from './env.js';
import type { ResolvedDeal } from './deals.js';

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
export const MODEL_SONNET = 'claude-sonnet-4-6';

const LONG_THREAD_MESSAGE_COUNT = 25;
const LONG_THREAD_CHARS = 12_000;
const LOW_CONFIDENCE_THRESHOLD = 0.45;

const SUGGESTED_ACTIONS: readonly SuggestedAction[] = ['bump', 'follow_up', 'none'];

const SYSTEM_PROMPT = `You are a CRM deal-intelligence assistant for a B2B sales team. You read a thread of Telegram messages from a GROUP CHAT that represents a single sales deal/opportunity, plus a snapshot of the matched Attio DEAL record and the list of resolved participants. You propose structured updates to the DEAL.

Output ONLY a single JSON object and nothing else — no prose, no markdown fences. The JSON MUST match this exact shape:

{
  "attio_object": "deals",
  "attio_record_id": "rec_... (the deal id provided) or null",
  "proposed_changes": { "<deal_attribute_slug>": <value> },
  "suggested_action": "bump" | "follow_up" | "none",
  "confidence": 0.0,
  "rationale": "one short line summarizing deal state",
  "source_message_ids": ["<chat_id>:<message_id>", ...],
  "participants": [ { "name": "as written in chat", "role": "champion|decision_maker|blocker|other" } ]
}

Rules:
- attio_record_id: echo the provided deal record_id if a deal snapshot was given; otherwise null. Never invent an id.
- proposed_changes: ONLY non-stage deal fields you have direct evidence for. Allowed examples: "next_step" (short text of the agreed next action), "next_step_date" (ISO date if explicitly stated), "last_touch_date" (ISO date of the latest message). Use the Attio deal attribute slug as the key. If nothing concrete, return {}.
- NEVER propose deal-stage / pipeline / amount / close-date / owner changes — those require human review and are out of scope here. Do not put them in proposed_changes.
- suggested_action: "bump" if the deal is dormant and the rep should re-engage; "follow_up" if there is an open commitment/next step; "none" otherwise.
- confidence: your honest 0.0-1.0 confidence in the overall deal read.
- source_message_ids: the "<chat_id>:<message_id>" ids justifying your read. Only ids present in the input.
- participants: who is active in the thread and their likely role; names as they appear. Advisory only.
- Never include values not supported by the message text.`;

export interface ExtractionResult {
  extraction: ClaudeExtraction;
  model: string;
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// prompt assembly
// ---------------------------------------------------------------------------

function renderThread(messages: ThreadMessage[]): string {
  return messages
    .map((m) => {
      const who = m.is_outgoing === 1 ? 'OWNER' : `USER:${m.sender_user_id ?? 'unknown'}`;
      const when = new Date(m.msg_date * 1000).toISOString();
      const id = `${m.chat_id}:${m.message_id}`;
      const text = m.text ?? '(no text / non-text message)';
      return `[${id}] (${when}) ${who}: ${text}`;
    })
    .join('\n');
}

function renderParticipants(participants: ProposalParticipant[]): string {
  if (participants.length === 0) return '(none resolved)';
  return participants
    .map(
      (p) =>
        `- tg_user ${p.telegram_user_id} | ${p.name ?? '(unknown name)'} | identity:${p.status}` +
        (p.attio_person_id ? ` | attio_person:${p.attio_person_id}` : '')
    )
    .join('\n');
}

function buildUserMessage(
  deal: ResolvedDeal,
  chatTitle: string | null,
  messages: ThreadMessage[],
  participants: ProposalParticipant[]
): string {
  const snapshot = deal.deal_snapshot
    ? JSON.stringify(deal.deal_snapshot, null, 2)
    : `null (no confident deal match — read the thread but leave attio_record_id null; status=${deal.status})`;

  return [
    `GROUP CHAT TITLE: ${chatTitle ?? '(none)'}`,
    `DEAL RESOLUTION STATUS: ${deal.status}`,
    `MATCHED ATTIO DEAL SNAPSHOT:`,
    snapshot,
    ``,
    `RESOLVED PARTICIPANTS (senders in this chat):`,
    renderParticipants(participants),
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
  return SUGGESTED_ACTIONS.includes(v as SuggestedAction) ? (v as SuggestedAction) : 'none';
}

function coerceSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function coerceParticipants(v: unknown): Array<{ name: string; role?: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ name: string; role?: string }> = [];
  for (const item of v) {
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      if (typeof o.name === 'string' && o.name.trim()) {
        out.push({ name: o.name, ...(typeof o.role === 'string' ? { role: o.role } : {}) });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the model's raw text into a normalized ClaudeExtraction (deal-shaped).
 * Always returns a well-formed object; on unparseable output returns a
 * zero-confidence no-op (which the workflow routes to human review).
 */
export function parseExtraction(raw: string): ClaudeExtraction {
  const fallback: ClaudeExtraction = {
    attio_object: 'deals',
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
  const participants = coerceParticipants(obj.participants);
  return {
    attio_object: typeof obj.attio_object === 'string' ? obj.attio_object : 'deals',
    attio_record_id: typeof recId === 'string' && recId.length > 0 ? recId : null,
    proposed_changes: changes,
    suggested_action: coerceAction(obj.suggested_action),
    confidence: clampConfidence(obj.confidence),
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    source_message_ids: coerceSourceIds(obj.source_message_ids),
    ...(participants ? { participants } : {}),
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

async function callMessages(env: Env, model: string, userMessage: string): Promise<string> {
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
  return (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * Run deal extraction for a group thread. Haiku by default; escalates to Sonnet
 * for long threads or low first-pass confidence. Output parsed defensively.
 */
export async function extractFromThread(
  env: Env,
  deal: ResolvedDeal,
  chatTitle: string | null,
  messages: ThreadMessage[],
  participants: ProposalParticipant[]
): Promise<ExtractionResult> {
  const userMessage = buildUserMessage(deal, chatTitle, messages, participants);

  const longThread =
    messages.length > LONG_THREAD_MESSAGE_COUNT || totalChars(messages) > LONG_THREAD_CHARS;

  if (longThread) {
    const raw = await callMessages(env, MODEL_SONNET, userMessage);
    return { extraction: parseExtraction(raw), model: MODEL_SONNET, escalated: true };
  }

  const haikuRaw = await callMessages(env, MODEL_HAIKU, userMessage);
  const haiku = parseExtraction(haikuRaw);

  if (haiku.confidence <= LOW_CONFIDENCE_THRESHOLD) {
    const sonnetRaw = await callMessages(env, MODEL_SONNET, userMessage);
    return { extraction: parseExtraction(sonnetRaw), model: MODEL_SONNET, escalated: true };
  }

  return { extraction: haiku, model: MODEL_HAIKU, escalated: false };
}
