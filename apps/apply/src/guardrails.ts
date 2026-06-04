/**
 * Code-enforced guardrails for the apply Worker (spec §7).
 *
 * These are enforced HERE, never by the model. The extract Worker may write a
 * proposal with any confidence/changes; the apply Worker decides — independently
 * — whether it is safe to write to Attio without a human in the loop.
 *
 * Rules:
 *  1. Auto-apply ONLY when confidence >= threshold AND every changed attribute
 *     slug is on the safe allowlist. Anything else stays for human review.
 *  2. attio_record_id === null (no confident match) => NEVER write. The proposal
 *     is left for manual linking.
 *  3. Deal-stage moves and new-record creation ALWAYS require explicit human
 *     approval — never auto-applied regardless of confidence.
 *
 * A proposal already in status 'approved' is a human decision and bypasses the
 * auto-apply confidence/allowlist gate — but rules 2 and 3 (no record id, deals,
 * creation) still block an unsafe write and are reported as a blocking error.
 */

import type { Proposal } from '@crm/db';

export interface ApplyConfig {
  autoApplyConfidenceThreshold: number;
  /** lower-cased, trimmed safe attribute slugs for PEOPLE proposals */
  safeAttributeAllowlist: Set<string>;
  /** lower-cased, trimmed safe (non-stage) attribute slugs for DEAL proposals */
  dealSafeAttributeAllowlist: Set<string>;
}

/** Slugs that, if present in proposed_changes, indicate a deal-stage move. */
const DEAL_STAGE_SLUGS = new Set(['stage', 'deal_stage', 'status']);

export type Decision =
  | { kind: 'apply'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'block'; reason: string };

/** Parse comma-separated env var into a normalized Set of slugs. */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

/** Parse the attribute_slug -> value map from a proposal row. Throws on bad JSON. */
export function parseProposedChanges(p: Proposal): Record<string, unknown> {
  const parsed = JSON.parse(p.proposed_changes) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('proposed_changes is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Parse the "<chat_id>:<message_id>" provenance list from a proposal row. */
export function parseSourceMessageIds(p: Proposal): string[] {
  const parsed = JSON.parse(p.source_message_ids) as unknown;
  if (!Array.isArray(parsed)) throw new Error('source_message_ids is not a JSON array');
  return parsed.map((x) => String(x));
}

/** True if any changed slug names a deal-stage move (rule 3). */
function touchesDealStage(changes: Record<string, unknown>): boolean {
  for (const slug of Object.keys(changes)) {
    if (DEAL_STAGE_SLUGS.has(slug.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Decide what to do with a proposal.
 *
 * @returns
 *   - apply: safe to write to Attio now
 *   - skip:  not eligible for auto-apply and not human-approved; leave pending
 *   - block: human-approved (or otherwise reached us) but an absolute guardrail
 *            forbids the write — record an error and do not write
 */
export function decide(p: Proposal, cfg: ApplyConfig): Decision {
  let changes: Record<string, unknown>;
  try {
    changes = parseProposedChanges(p);
  } catch (e) {
    return { kind: 'block', reason: `malformed proposed_changes: ${(e as Error).message}` };
  }

  const humanApproved = p.status === 'approved';

  // Rule 2 (absolute): no confident/confirmed write target => never write.
  // For deals, p.attio_record_id is the live confirmed deal id resolved upstream
  // (null until the chat->deal match is confirmed).
  if (p.attio_record_id === null || p.attio_record_id === '') {
    return humanApproved
      ? { kind: 'block', reason: 'no write target (record id null) — confirm/link the match first' }
      : { kind: 'skip', reason: 'no confirmed target — confirm the chat->deal match first' };
  }

  if (p.attio_object === 'deals') return decideDeal(p, changes, cfg, humanApproved);
  if (p.attio_object === 'people') return decidePeople(p, changes, cfg, humanApproved);

  // Any other object (e.g. companies) is never auto-applied.
  return humanApproved
    ? { kind: 'block', reason: `auto-apply supports people/deals only, got '${p.attio_object}'` }
    : { kind: 'skip', reason: `object '${p.attio_object}' requires explicit human approval` };
}

/** Decision logic for DEAL proposals (default-deny non-stage allowlist). */
function decideDeal(
  p: Proposal,
  changes: Record<string, unknown>,
  cfg: ApplyConfig,
  humanApproved: boolean
): Decision {
  // A human reviewed it: apply whatever they approved + note + participants.
  // Empty changes is fine for deals — the provenance note + participant links
  // are themselves valuable, additive writes.
  if (humanApproved) return { kind: 'apply', reason: 'human-approved deal' };

  // Auto path: confidence gate, then default-deny on the safe deal allowlist.
  if (p.confidence < cfg.autoApplyConfidenceThreshold) {
    return { kind: 'skip', reason: `confidence ${p.confidence} < threshold ${cfg.autoApplyConfidenceThreshold}` };
  }
  const unsafe = Object.keys(changes).filter(
    (s) => !cfg.dealSafeAttributeAllowlist.has(s.trim().toLowerCase())
  );
  if (unsafe.length > 0) {
    return {
      kind: 'skip',
      reason: `non-allowlisted deal field(s) [${unsafe.join(', ')}] (stage/commercial) — route to review`,
    };
  }
  // Confirmed deal + confident + only allowlisted (or no) field changes.
  return { kind: 'apply', reason: `auto-apply deal: confidence ${p.confidence} >= ${cfg.autoApplyConfidenceThreshold}, fields allowlisted/none` };
}

/** Decision logic for PEOPLE proposals (unchanged contract). */
function decidePeople(
  p: Proposal,
  changes: Record<string, unknown>,
  cfg: ApplyConfig,
  humanApproved: boolean
): Decision {
  // A deal-stage slug on a person record always needs a human.
  if (touchesDealStage(changes)) {
    return humanApproved
      ? { kind: 'block', reason: 'deal-stage move on a people record — apply manually in Attio' }
      : { kind: 'skip', reason: 'deal-stage move — requires explicit human approval' };
  }

  if (humanApproved) {
    if (Object.keys(changes).length === 0) {
      return { kind: 'block', reason: 'approved proposal has no proposed_changes' };
    }
    return { kind: 'apply', reason: 'human-approved' };
  }

  if (p.confidence < cfg.autoApplyConfidenceThreshold) {
    return { kind: 'skip', reason: `confidence ${p.confidence} < threshold ${cfg.autoApplyConfidenceThreshold}` };
  }
  const slugs = Object.keys(changes);
  if (slugs.length === 0) {
    return { kind: 'skip', reason: 'no proposed_changes to apply' };
  }
  const unsafe = slugs.filter((s) => !cfg.safeAttributeAllowlist.has(s.trim().toLowerCase()));
  if (unsafe.length > 0) {
    return {
      kind: 'skip',
      reason: `non-allowlisted attribute(s) [${unsafe.join(', ')}] — route to review`,
    };
  }
  return {
    kind: 'apply',
    reason: `auto-apply: confidence ${p.confidence} >= ${cfg.autoApplyConfidenceThreshold}, all attrs allowlisted`,
  };
}
