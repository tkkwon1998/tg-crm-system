import { describe, it, expect } from 'vitest';
import type { Proposal } from '@crm/db';
import {
  decide,
  parseAllowlist,
  parseProposedChanges,
  parseSourceMessageIds,
  type ApplyConfig,
} from '../apps/apply/src/guardrails.js';

const cfg: ApplyConfig = {
  autoApplyConfidenceThreshold: 0.85,
  safeAttributeAllowlist: new Set(['email', 'phone', 'title']),
};

/** Build a Proposal row with sensible defaults; override per case. */
function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    telegram_user_id: 42,
    attio_object: 'people',
    attio_record_id: 'rec_123',
    proposed_changes: JSON.stringify({ email: 'jane@acme.com' }),
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

describe('decide (apply) — auto-apply gate', () => {
  it('applies a confident, allowlisted, pending people-update', () => {
    expect(decide(proposal(), cfg).kind).toBe('apply');
  });

  it('skips when confidence is below threshold', () => {
    const d = decide(proposal({ confidence: 0.5 }), cfg);
    expect(d.kind).toBe('skip');
    expect(d.reason).toMatch(/confidence/);
  });

  it('skips when an attribute is not on the allowlist', () => {
    const d = decide(
      proposal({ proposed_changes: JSON.stringify({ favorite_color: 'blue' }) }),
      cfg
    );
    expect(d.kind).toBe('skip');
    expect(d.reason).toMatch(/non-allowlisted/);
  });

  it('skips a pending proposal with no changes', () => {
    const d = decide(proposal({ proposed_changes: '{}' }), cfg);
    expect(d.kind).toBe('skip');
  });
});

describe('decide (apply) — absolute guardrails', () => {
  it('rule 2: null record id — skip when pending, block when approved', () => {
    expect(decide(proposal({ attio_record_id: null }), cfg).kind).toBe('skip');
    expect(decide(proposal({ attio_record_id: null, status: 'approved' }), cfg).kind).toBe('block');
  });

  it('rule 3: deal-stage move — skip when pending, block when approved', () => {
    const changes = JSON.stringify({ stage: 'won' });
    expect(decide(proposal({ proposed_changes: changes }), cfg).kind).toBe('skip');
    expect(
      decide(proposal({ proposed_changes: changes, status: 'approved' }), cfg).kind
    ).toBe('block');
  });

  it('rule 3: deals object — skip when pending, block when approved', () => {
    expect(decide(proposal({ attio_object: 'deals' }), cfg).kind).toBe('skip');
    expect(decide(proposal({ attio_object: 'deals', status: 'approved' }), cfg).kind).toBe('block');
  });

  it('non-people object is never auto-applied', () => {
    expect(decide(proposal({ attio_object: 'companies' }), cfg).kind).toBe('skip');
  });
});

describe('decide (apply) — human-approved path', () => {
  it('applies an approved people-update even below the auto threshold', () => {
    const d = decide(
      proposal({ status: 'approved', confidence: 0.1, proposed_changes: JSON.stringify({ title: 'CTO' }) }),
      cfg
    );
    expect(d.kind).toBe('apply');
    expect(d.reason).toMatch(/human-approved/);
  });

  it('blocks an approved proposal that has no changes', () => {
    const d = decide(proposal({ status: 'approved', proposed_changes: '{}' }), cfg);
    expect(d.kind).toBe('block');
  });

  it('blocks on malformed proposed_changes JSON', () => {
    const d = decide(proposal({ proposed_changes: 'not json' }), cfg);
    expect(d.kind).toBe('block');
    expect(d.reason).toMatch(/malformed/);
  });
});

describe('apply parse helpers', () => {
  it('parseAllowlist normalizes case/whitespace and drops blanks', () => {
    const set = parseAllowlist('Email, phone ,, TITLE ');
    expect([...set].sort()).toEqual(['email', 'phone', 'title']);
    expect(parseAllowlist(undefined).size).toBe(0);
  });

  it('parseProposedChanges rejects arrays and non-objects', () => {
    expect(parseProposedChanges(proposal({ proposed_changes: JSON.stringify({ a: 1 }) }))).toEqual({ a: 1 });
    expect(() => parseProposedChanges(proposal({ proposed_changes: '[1,2]' }))).toThrow();
    expect(() => parseProposedChanges(proposal({ proposed_changes: 'null' }))).toThrow();
  });

  it('parseSourceMessageIds coerces to a string array and rejects non-arrays', () => {
    expect(parseSourceMessageIds(proposal({ source_message_ids: JSON.stringify(['1:2', '3:4']) }))).toEqual(['1:2', '3:4']);
    expect(() => parseSourceMessageIds(proposal({ source_message_ids: '{}' }))).toThrow();
  });
});
