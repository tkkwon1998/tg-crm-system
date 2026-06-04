import { describe, it, expect } from 'vitest';
import type { Proposal } from '@crm/db';
import {
  decide,
  parseAllowlist,
  parseProposedChanges,
  parseSourceMessageIds,
  partitionDealChanges,
  type ApplyConfig,
} from '../apps/apply/src/guardrails.js';

const cfg: ApplyConfig = {
  autoApplyConfidenceThreshold: 0.85,
  safeAttributeAllowlist: new Set(['email', 'phone', 'title']),
  dealSafeAttributeAllowlist: new Set(['next_step', 'next_step_date', 'last_touch_date']),
};

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    telegram_user_id: 42,
    telegram_chat_id: null,
    attio_object: 'people',
    attio_record_id: 'rec_123',
    proposed_changes: JSON.stringify({ email: 'jane@acme.com' }),
    participants_json: null,
    suggested_action: 'follow_up',
    confidence: 0.92,
    rationale: 'shared email',
    source_message_ids: JSON.stringify(['1001:55']),
    status: 'pending',
    applied_at: null,
    error: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

describe('decide — people auto-apply gate', () => {
  it('applies a confident, allowlisted, pending people-update', () => {
    expect(decide(proposal(), cfg).kind).toBe('apply');
  });
  it('skips when confidence is below threshold', () => {
    expect(decide(proposal({ confidence: 0.5 }), cfg).kind).toBe('skip');
  });
  it('skips a non-allowlisted attribute', () => {
    expect(decide(proposal({ proposed_changes: JSON.stringify({ favorite_color: 'blue' }) }), cfg).kind).toBe('skip');
  });
  it('skips a pending people proposal with no changes', () => {
    expect(decide(proposal({ proposed_changes: '{}' }), cfg).kind).toBe('skip');
  });
  it('applies an approved people-update even below threshold', () => {
    const d = decide(proposal({ status: 'approved', confidence: 0.1, proposed_changes: JSON.stringify({ title: 'CTO' }) }), cfg);
    expect(d.kind).toBe('apply');
  });
  it('blocks an approved people proposal with no changes', () => {
    expect(decide(proposal({ status: 'approved', proposed_changes: '{}' }), cfg).kind).toBe('block');
  });
  it('routes a deal-stage slug on a people record to review', () => {
    expect(decide(proposal({ proposed_changes: JSON.stringify({ stage: 'won' }) }), cfg).kind).toBe('skip');
    expect(decide(proposal({ status: 'approved', proposed_changes: JSON.stringify({ stage: 'won' }) }), cfg).kind).toBe('block');
  });
});

describe('decide — deal proposals (note-centric)', () => {
  const deal = (over: Partial<Proposal> = {}) =>
    proposal({
      attio_object: 'deals',
      telegram_chat_id: -100,
      attio_record_id: 'rec_deal_1', // effective confirmed deal id (resolved upstream)
      proposed_changes: '{}',
      ...over,
    });

  it('applies any CONFIRMED deal — the note is the deliverable (even at low confidence)', () => {
    expect(decide(deal(), cfg).kind).toBe('apply');
    expect(decide(deal({ confidence: 0.2 }), cfg).kind).toBe('apply');
    expect(decide(deal({ proposed_changes: JSON.stringify({ stage: 'won', next_step: 'x' }) }), cfg).kind).toBe('apply');
  });
  it('does NOT write an UNCONFIRMED deal (null target) — skip pending, block approved', () => {
    expect(decide(deal({ attio_record_id: null }), cfg).kind).toBe('skip');
    expect(decide(deal({ attio_record_id: null, status: 'approved' }), cfg).kind).toBe('block');
  });
  it('applies a human-approved deal', () => {
    expect(decide(deal({ status: 'approved', confidence: 0.2 }), cfg).kind).toBe('apply');
  });
});

describe('partitionDealChanges — what auto-writes vs. surfaces for review', () => {
  const allow = new Set(['next_step', 'last_touch_date']);
  it('splits allowlisted (write) from stage/commercial (review)', () => {
    const { write, review } = partitionDealChanges(
      { next_step: 'call Tue', last_touch_date: '2026-06-04', stage: 'won', amount: 100 },
      allow
    );
    expect(write).toEqual({ next_step: 'call Tue', last_touch_date: '2026-06-04' });
    expect(review).toEqual({ stage: 'won', amount: 100 });
  });
  it('an empty allowlist routes ALL fields to review (note-only workspace)', () => {
    const { write, review } = partitionDealChanges({ next_step: 'x', stage: 'won' }, new Set());
    expect(write).toEqual({});
    expect(review).toEqual({ next_step: 'x', stage: 'won' });
  });
});

describe('decide — other objects', () => {
  it('never auto-applies a non-people/deal object', () => {
    expect(decide(proposal({ attio_object: 'companies' }), cfg).kind).toBe('skip');
    expect(decide(proposal({ attio_object: 'companies', status: 'approved' }), cfg).kind).toBe('block');
  });
});

describe('apply parse helpers', () => {
  it('parseAllowlist normalizes case/whitespace and drops blanks', () => {
    expect([...parseAllowlist('Email, phone ,, TITLE ')].sort()).toEqual(['email', 'phone', 'title']);
    expect(parseAllowlist(undefined).size).toBe(0);
  });
  it('parseProposedChanges rejects arrays and non-objects', () => {
    expect(parseProposedChanges(proposal({ proposed_changes: JSON.stringify({ a: 1 }) }))).toEqual({ a: 1 });
    expect(() => parseProposedChanges(proposal({ proposed_changes: '[1,2]' }))).toThrow();
  });
  it('parseSourceMessageIds coerces to a string array', () => {
    expect(parseSourceMessageIds(proposal({ source_message_ids: JSON.stringify(['1:2']) }))).toEqual(['1:2']);
    expect(() => parseSourceMessageIds(proposal({ source_message_ids: '{}' }))).toThrow();
  });
});
