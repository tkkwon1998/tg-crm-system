import { describe, it, expect } from 'vitest';
import type { ClaudeExtraction } from '@crm/db';
import { evaluateGuardrails } from '../apps/extract/src/workflow.js';

/** A confident, safe, auto-eligible DEAL extraction we can mutate per case. */
function extraction(over: Partial<ClaudeExtraction> = {}): ClaudeExtraction {
  return {
    attio_object: 'deals',
    attio_record_id: 'rec_deal_1',
    proposed_changes: { next_step: 'send pricing deck' },
    suggested_action: 'follow_up',
    confidence: 0.92,
    rationale: 'agreed next step on the thread',
    source_message_ids: ['1001:55'],
    ...over,
  };
}

const THRESHOLD = 0.85;

describe('evaluateGuardrails (extract, deal-centric)', () => {
  it('always persists status "pending" (never auto-approves)', () => {
    expect(evaluateGuardrails(extraction(), THRESHOLD).status).toBe('pending');
    expect(evaluateGuardrails(extraction({ confidence: 0.1 }), THRESHOLD).status).toBe('pending');
  });

  it('marks a confident, allowlisted deal field auto-apply eligible', () => {
    const d = evaluateGuardrails(extraction(), THRESHOLD);
    expect(d.autoApplyEligible).toBe(true);
    expect(d.reasons).toContain('auto_apply_eligible');
  });

  it('guardrail #2: null deal record id is never auto-eligible', () => {
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

  it('default-deny: a non-allowlisted attribute blocks auto-apply', () => {
    const d = evaluateGuardrails(
      extraction({ proposed_changes: { random_field: 'x' } }),
      THRESHOLD
    );
    expect(d.autoApplyEligible).toBe(false);
    expect(d.reasons).toContain('unsafe_attribute(random_field)');
  });

  it('guardrail #3: deal-stage / commercial moves always route to review', () => {
    for (const slug of ['stage', 'amount', 'close_date', 'pipeline']) {
      const d = evaluateGuardrails(
        extraction({ proposed_changes: { [slug]: 'whatever' } }),
        THRESHOLD
      );
      expect(d.autoApplyEligible).toBe(false);
      expect(d.reasons).toContain(`review_always_attribute(${slug})`);
    }
  });

  it('accepts multiple allowlisted deal fields together', () => {
    const d = evaluateGuardrails(
      extraction({
        proposed_changes: {
          next_step: 'demo Tuesday',
          next_step_date: '2026-06-10',
          last_touch_date: '2026-06-04',
        },
      }),
      THRESHOLD
    );
    expect(d.autoApplyEligible).toBe(true);
  });
});
