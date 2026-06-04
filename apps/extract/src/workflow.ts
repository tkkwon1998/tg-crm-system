/**
 * ExtractWorkflow — durable per-group-chat pipeline (deal-centric flow).
 *
 * Steps (each a checkpointed, auto-retried step.do):
 *   1. resolve-deal     — fuzzy-match the chat title to an Attio deal (deal_map).
 *   2. participants     — resolve the distinct senders to people (identity_map).
 *   3. extract          — Claude reads the thread + deal snapshot -> proposal.
 *   4. propose          — code-enforced guardrails, then write crm_proposals and
 *                         mark the thread's messages extracted.
 *
 * Guardrails (contract — enforced HERE, never trusted from the model):
 *   1. Auto-apply-eligible ONLY when confidence >= threshold AND every key in
 *      proposed_changes is on the SAFE_DEAL_ATTRIBUTES allowlist (non-stage,
 *      additive deal fields). Everything else is persisted 'pending' for review.
 *   2. No confident deal match (attio_record_id null) => never a write target.
 *   3. Deal-stage / pipeline / amount / close-date / owner moves ALWAYS route to
 *      review (default-deny: anything not on the safe allowlist blocks auto-apply).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  insertProposal,
  markMessagesExtracted,
  type ClaudeExtraction,
  type ProposalParticipant,
} from '@crm/db';
import type { Env, ThreadWorkflowParams } from './env.js';
import { resolveDeal, type ResolvedDeal } from './deals.js';
import { resolveParticipants } from './identity.js';
import { extractFromThread } from './claude.js';

function doStep<T>(step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T> {
  return (step.do as (n: string, f: () => Promise<unknown>) => Promise<unknown>)(
    name,
    fn
  ) as Promise<T>;
}

const DEFAULT_AUTO_APPLY_THRESHOLD = 0.85;

/**
 * Safe DEAL attributes that may be auto-applied without human review
 * (additive / non-stage). Anything outside this set forces 'pending' review.
 */
const SAFE_DEAL_ATTRIBUTES = new Set<string>([
  'next_step',
  'next_steps',
  'next_step_date',
  'last_touch',
  'last_touch_date',
  'last_contacted',
]);

/**
 * Attribute slugs that ALWAYS require human approval (deal-stage / commercial
 * terms). Reported explicitly; the default-deny allowlist above also blocks them.
 */
const REVIEW_ALWAYS_ATTRIBUTES = new Set<string>([
  'stage',
  'deal_stage',
  'pipeline',
  'pipeline_stage',
  'status',
  'amount',
  'value',
  'close_date',
  'owner',
]);

interface GuardrailDecision {
  status: 'pending';
  autoApplyEligible: boolean;
  reasons: string[];
}

/** Apply the code-enforced guardrails to a (model-produced) deal extraction. */
export function evaluateGuardrails(
  extraction: ClaudeExtraction,
  threshold: number
): GuardrailDecision {
  const reasons: string[] = [];
  const changeKeys = Object.keys(extraction.proposed_changes ?? {});
  let autoApplyEligible = true;

  // Guardrail #2: no confident deal match => never a write target.
  if (!extraction.attio_record_id) {
    autoApplyEligible = false;
    reasons.push('no_attio_record_id');
  }

  if (changeKeys.length === 0) {
    autoApplyEligible = false;
    reasons.push('no_proposed_changes');
  }

  // Guardrail #1: confidence threshold.
  if (extraction.confidence < threshold) {
    autoApplyEligible = false;
    reasons.push(`confidence_below_threshold(${extraction.confidence}<${threshold})`);
  }

  // Guardrail #3: deal-stage / commercial-term moves always need a human.
  for (const k of changeKeys) {
    if (REVIEW_ALWAYS_ATTRIBUTES.has(k)) {
      autoApplyEligible = false;
      reasons.push(`review_always_attribute(${k})`);
    }
  }

  // Guardrail #1 (default-deny): every changed attribute must be on the safe
  // deal allowlist; anything else routes to review.
  for (const k of changeKeys) {
    if (!SAFE_DEAL_ATTRIBUTES.has(k)) {
      autoApplyEligible = false;
      reasons.push(`unsafe_attribute(${k})`);
    }
  }

  if (autoApplyEligible) reasons.push('auto_apply_eligible');
  return { status: 'pending', autoApplyEligible, reasons };
}

export class ExtractWorkflow extends WorkflowEntrypoint<Env, ThreadWorkflowParams> {
  async run(
    event: Readonly<WorkflowEvent<ThreadWorkflowParams>>,
    step: WorkflowStep
  ): Promise<{ proposalId: number | null; status: string; autoApplyEligible: boolean }> {
    const params = event.payload;
    const keys = params.messages.map((m) => ({ chat_id: m.chat_id, message_id: m.message_id }));

    if (params.messages.length === 0) {
      await doStep(step, 'mark-extracted-noop', async () => {
        await markMessagesExtracted(this.env.DB, keys);
        return keys.length;
      });
      return { proposalId: null, status: 'skipped_empty', autoApplyEligible: false };
    }

    // --- Step 1: resolve the chat -> deal (fuzzy title match, persisted) ---
    const deal = await doStep<ResolvedDeal>(step, 'resolve-deal', async () => {
      return await resolveDeal(this.env, params.chat_id, params.chat_title);
    });

    // --- Step 2: resolve participants (distinct senders -> people) ---
    const participants = await doStep<ProposalParticipant[]>(step, 'participants', async () => {
      return await resolveParticipants(this.env, params.messages);
    });

    // --- Step 3: Claude deal extraction (defensive parse) ---
    const extraction = await doStep<ClaudeExtraction>(step, 'extract', async () => {
      const result = await extractFromThread(
        this.env,
        deal,
        params.chat_title,
        params.messages,
        participants
      );
      // Guardrail #2 reinforced at source: only a CONFIRMED deal is a write
      // target; force the record id to null otherwise.
      const trustedDealId = deal.status === 'confirmed' ? deal.attio_deal_id : null;
      return { ...result.extraction, attio_object: 'deals', attio_record_id: trustedDealId };
    });

    // --- Step 4: guardrails + write crm_proposals + mark extracted ---
    const threshold = parseThreshold(this.env.AUTO_APPLY_THRESHOLD);
    const decision = evaluateGuardrails(extraction, threshold);

    const proposalId = await doStep<number>(step, 'propose', async () => {
      const sourceIds =
        extraction.source_message_ids.length > 0
          ? extraction.source_message_ids
          : keys.map((k) => `${k.chat_id}:${k.message_id}`);

      // Merge model-inferred roles into the resolved participants (advisory).
      const enriched = mergeRoles(participants, extraction.participants);

      const rationale = [
        extraction.rationale || '(no rationale)',
        `[deal:${deal.status}/${deal.match_method ?? 'n/a'} guardrails: ${decision.reasons.join(', ')}]`,
      ].join(' ');

      return await insertProposal(this.env.DB, {
        telegram_user_id: null,
        telegram_chat_id: params.chat_id,
        attio_object: 'deals',
        attio_record_id: extraction.attio_record_id, // null unless confirmed deal (guardrail #2)
        proposed_changes: extraction.proposed_changes,
        participants: enriched,
        suggested_action: extraction.suggested_action,
        confidence: extraction.confidence,
        rationale,
        source_message_ids: sourceIds,
        status: decision.status, // always 'pending' from extract
      });
    });

    await doStep(step, 'mark-extracted', async () => {
      await markMessagesExtracted(this.env.DB, keys);
      return keys.length;
    });

    return { proposalId, status: decision.status, autoApplyEligible: decision.autoApplyEligible };
  }
}

/** Attach model-inferred roles to resolved participants by best-effort name match. */
function mergeRoles(
  participants: ProposalParticipant[],
  inferred: ClaudeExtraction['participants']
): ProposalParticipant[] {
  if (!inferred || inferred.length === 0) return participants;
  return participants.map((p) => {
    if (!p.name) return p;
    const hit = inferred.find(
      (i) => i.name && p.name && i.name.toLowerCase().includes(p.name.toLowerCase())
    );
    return hit?.role ? { ...p, role: hit.role } : p;
  });
}

function parseThreshold(raw: string | undefined): number {
  if (!raw) return DEFAULT_AUTO_APPLY_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_AUTO_APPLY_THRESHOLD;
}
