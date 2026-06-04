/**
 * ExtractWorkflow — the durable per-thread pipeline (spec §5.2).
 *
 * Steps (each is a checkpointed, automatically-retried step.do):
 *   1. resolve  — resolve the counterparty identity against Attio, persist it.
 *   2. extract  — call Claude to produce a structured proposal (defensive parse).
 *   3. propose  — apply CODE-ENFORCED guardrails, then write crm_proposals and
 *                 mark the thread's messages extracted.
 *
 * Guardrails (contract — enforced HERE, never trusted from the model):
 *   1. Auto-eligible ONLY when confidence >= AUTO_APPLY_THRESHOLD AND every key
 *      in proposed_changes is on the SAFE_ATTRIBUTES allowlist. Otherwise the
 *      proposal is written with status 'pending' (human review). We never set
 *      'approved' here — auto-apply eligibility is signalled to the apply Worker
 *      via the proposal contents (high confidence + allowlisted attrs); the
 *      apply Worker owns its own auto-apply gate. We never write Attio from here.
 *   2. attio_record_id === null  => never a write target; persist for manual
 *      linking with attio_record_id left null.
 *   3. Deal-stage moves and new-record creation ALWAYS route to review (we hard
 *      block deal-stage attribute slugs and never emit record-creation here).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  insertProposal,
  markMessagesExtracted,
  type ClaudeExtraction,
} from '@crm/db';
import type { Env, ThreadWorkflowParams } from './env.js';
import { deriveSignals, resolveIdentity, type ResolvedIdentity } from './identity.js';
import { extractFromThread } from './claude.js';

/**
 * Run a checkpointed step that returns an arbitrary JSON-serializable object.
 * `step.do`'s `Serializable<T>` constraint is conservative about
 * `Record<string, unknown>` payloads (and recurses too deeply on our types); our
 * step results are genuinely JSON-serializable, so we localize one narrow cast
 * here instead of sprinkling assertions through the run() body.
 */
function doStep<T>(step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T> {
  return (step.do as (n: string, f: () => Promise<unknown>) => Promise<unknown>)(
    name,
    fn
  ) as Promise<T>;
}

/** Confidence threshold for auto-apply eligibility (overridable via var). */
const DEFAULT_AUTO_APPLY_THRESHOLD = 0.85;

/**
 * Safe attributes that may be auto-applied without human review (guardrail #1).
 * Anything outside this set forces the proposal to 'pending'.
 */
const SAFE_ATTRIBUTES = new Set<string>([
  'phone',
  'phone_numbers',
  'email',
  'email_addresses',
  'title',
  'job_title',
]);

/**
 * Attribute slugs that ALWAYS require human approval and must never be
 * auto-applied (guardrail #3 — deal-stage moves and record-creation signals).
 */
const REVIEW_ALWAYS_ATTRIBUTES = new Set<string>([
  'stage',
  'deal_stage',
  'status',
  'pipeline',
  'pipeline_stage',
]);

interface GuardrailDecision {
  /** Final persisted proposal status. Always 'pending' from this Worker. */
  status: 'pending';
  /** Whether the proposal is eligible for the apply Worker's auto-apply path. */
  autoApplyEligible: boolean;
  reasons: string[];
}

/** Apply the code-enforced guardrails to a (model-produced) extraction. */
export function evaluateGuardrails(
  extraction: ClaudeExtraction,
  threshold: number
): GuardrailDecision {
  const reasons: string[] = [];
  const changeKeys = Object.keys(extraction.proposed_changes ?? {});

  let autoApplyEligible = true;

  // Guardrail #2: no confident match => never a write target.
  if (!extraction.attio_record_id) {
    autoApplyEligible = false;
    reasons.push('no_attio_record_id');
  }

  // Nothing to change => nothing to auto-apply.
  if (changeKeys.length === 0) {
    autoApplyEligible = false;
    reasons.push('no_proposed_changes');
  }

  // Guardrail #1: confidence threshold.
  if (extraction.confidence < threshold) {
    autoApplyEligible = false;
    reasons.push(`confidence_below_threshold(${extraction.confidence}<${threshold})`);
  }

  // Guardrail #3: deal-stage / record-status moves always need a human.
  for (const k of changeKeys) {
    if (REVIEW_ALWAYS_ATTRIBUTES.has(k)) {
      autoApplyEligible = false;
      reasons.push(`review_always_attribute(${k})`);
    }
  }

  // Guardrail #1: every changed attribute must be on the safe allowlist.
  for (const k of changeKeys) {
    if (!SAFE_ATTRIBUTES.has(k)) {
      autoApplyEligible = false;
      reasons.push(`unsafe_attribute(${k})`);
    }
  }

  if (autoApplyEligible) reasons.push('auto_apply_eligible');

  // We never auto-mark 'approved' here — everything is persisted 'pending' and
  // the apply Worker owns the final auto-apply gate.
  return { status: 'pending', autoApplyEligible, reasons };
}

export class ExtractWorkflow extends WorkflowEntrypoint<Env, ThreadWorkflowParams> {
  async run(
    event: Readonly<WorkflowEvent<ThreadWorkflowParams>>,
    step: WorkflowStep
  ): Promise<{ proposalId: number | null; status: string; autoApplyEligible: boolean }> {
    const params = event.payload;
    const keys = params.messages.map((m) => ({
      chat_id: m.chat_id,
      message_id: m.message_id,
    }));

    // No counterparty to attribute (e.g. an all-outgoing or service thread):
    // mark extracted so we don't reprocess, and stop. This is its own step so
    // a retry never double-runs the rest.
    if (params.counterparty_user_id == null || params.messages.length === 0) {
      await doStep(step, 'mark-extracted-noop', async () => {
        await markMessagesExtracted(this.env.DB, keys);
        return keys.length;
      });
      return { proposalId: null, status: 'skipped_no_counterparty', autoApplyEligible: false };
    }

    const counterpartyId = params.counterparty_user_id;

    // --- Step 1: resolve identity (Attio calls + persist to identity_map) ---
    const identity = await doStep<ResolvedIdentity>(step, 'resolve', async () => {
      const signals = deriveSignals(counterpartyId, params.chat_title, params.messages);
      return await resolveIdentity(this.env, signals);
    });

    // --- Step 2: extract via Claude (defensive parse) ---
    const extraction = await doStep<ClaudeExtraction>(step, 'extract', async () => {
      const result = await extractFromThread(
        this.env,
        identity,
        params.chat_title,
        params.messages
      );
      // Guardrail #2 reinforced at the source: if identity has no confident
      // (confirmed/phone) record id, force the proposal's record id to null so
      // it can never become a write target downstream.
      const trustedRecordId =
        identity.status === 'confirmed' ? identity.attio_record_id : null;
      return { ...result.extraction, attio_record_id: trustedRecordId };
    });

    // --- Step 3: guardrails + write crm_proposals + mark extracted ---
    const threshold = parseThreshold(this.env.AUTO_APPLY_THRESHOLD);
    const decision = evaluateGuardrails(extraction, threshold);

    const proposalId = await doStep<number>(step, 'propose', async () => {
      // Always carry the real source ids for this thread as provenance, even
      // if the model omitted some; intersect-or-fallback to the thread keys.
      const sourceIds =
        extraction.source_message_ids.length > 0
          ? extraction.source_message_ids
          : keys.map((k) => `${k.chat_id}:${k.message_id}`);

      const rationale = [
        extraction.rationale || '(no rationale)',
        `[guardrails: ${decision.reasons.join(', ')}]`,
      ].join(' ');

      const id = await insertProposal(this.env.DB, {
        telegram_user_id: counterpartyId,
        attio_object: 'people',
        attio_record_id: extraction.attio_record_id, // null when unmatched (guardrail #2)
        proposed_changes: extraction.proposed_changes,
        suggested_action: extraction.suggested_action,
        confidence: extraction.confidence,
        rationale,
        source_message_ids: sourceIds,
        status: decision.status, // always 'pending' from extract
      });
      return id;
    });

    // Mark the thread's messages extracted only after the proposal is durably
    // written (its own step => idempotent on Workflow retry).
    await doStep(step, 'mark-extracted', async () => {
      await markMessagesExtracted(this.env.DB, keys);
      return keys.length;
    });

    return {
      proposalId,
      status: decision.status,
      autoApplyEligible: decision.autoApplyEligible,
    };
  }
}

function parseThreshold(raw: string | undefined): number {
  if (!raw) return DEFAULT_AUTO_APPLY_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_AUTO_APPLY_THRESHOLD;
}
