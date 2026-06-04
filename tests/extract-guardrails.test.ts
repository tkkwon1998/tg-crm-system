import { describe, it, expect } from 'vitest';
import type { ClaudeExtraction } from '@crm/db';
import { evaluateGuardrails } from '../apps/extract/src/workflow.js';

/** A confident, safe, auto-eligible extraction we can mutate per case. */
function extraction(over: Partial<ClaudeExtraction> = {}): ClaudeExtraction {
  return {
    attio_object: 'people',
    attio_record_id: 'rec_123',
    proposed_changes: { email: 'jane@acme.com' },
    suggested_action: 'follow_up',
    confidence: 0.92,
    rationale: 'shared a new work email',
    source_message_ids: ['1001:55'],
    ...over,
  };
}

const THRESHOLD = 0.85;

describe('evaluateGuardrails (extract)', () => {
  it('always persists status "pending" (never auto-approves)', () => {
    expect(evaluateGuardrails(extraction(), THRESHOLD).status).toBe('pending');
    expect(
      evaluateGuardrails(extraction({ confidence: 0.1 }), THRESHOLD).status
    ).toBe('pending');
  });

  it('marks a confident, allowlisted change auto-apply eligible', () => {
    const d = evaluateGuardrails(extraction(), THRESHOLD);
    expect(d.autoApplyEligible).toBe(true);
    expect(d.reasons).toContain('auto_apply_eligible');
  });

  it('guardrail #2: null attio_record_id is never auto-eligible', () => {
    const d = evaluateGuardrails(extraction({ attio_record_id: null }), THRESHOLD);
    expect(d.autoApplyEligible).toBe(false);
    expect(d.reasons).toContain('no_attio_record_id');
  });

  it('an empty change-set is not auto-eligible', () => {
    const d = evaluateGuardrails(extraction({ proposed_changes: {} }), THRESHOLD);
    expect(d.autoApplyEligible).toBe(false);
    expect(d.reasons).toContain('no_proposed_changes');
  });

  it('guardrail #1: confidence below threshold blocks auto-apply', () => {
    const d = evaluateGuardrails(extraction({ confidence: 0.5 }), THRESHOLD);
    expect(d.autoApplyEligible).toBe(false);
    expect(d.reasons.some((r) => r.startsWith('confidence_below_threshold'))).toBe(true);
  });

  it('guardrail #1: a non-allowlisted attribute blocks auto-apply', () => {
    const d = evaluateGuardrails(
      extraction({ proposed_changes: { favorite_color: 'blue' } }),
      THRESHOLD
    );
    expect(d.autoApplyEligible).toBe(false);
    expect(d.reasons).toContain('unsafe_attribute(favorite_color)');
  });

  it('guardrail #3: a deal-stage attribute always routes to review', () => {
    const d = evaluateGuardrails(
      extraction({ proposed_changes: { stage: 'won' } }),
      THRESHOLD
    );
    expect(d.autoApplyEligible).toBe(false);
    expect(d.reasons).toContain('review_always_attribute(stage)');
  });

  it('accepts multiple allowlisted attributes together', () => {
    const d = evaluateGuardrails(
      extraction({ proposed_changes: { email: 'a@b.com', phone: '+15551234567', title: 'CTO' } }),
      THRESHOLD
    );
    expect(d.autoApplyEligible).toBe(true);
  });
});
