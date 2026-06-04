import { describe, it, expect } from 'vitest';
import { titleSimilarity } from '../apps/extract/src/deals.js';

describe('titleSimilarity — fuzzy chat-title -> deal-name match', () => {
  it('scores exact (normalized) matches as 1', () => {
    expect(titleSimilarity('Acme Deal', 'Acme Deal')).toBe(1);
    expect(titleSimilarity('ACME, INC.', 'acme inc')).toBe(1); // case + punctuation insensitive
  });

  it('scores a subset/containment match highly', () => {
    expect(titleSimilarity('Acme', 'Acme Corp Q3')).toBeGreaterThan(0.5);
    expect(titleSimilarity('Theo x Acme partnership', 'Acme')).toBeGreaterThan(0.5);
  });

  it('gives a partial score for partial token overlap', () => {
    const s = titleSimilarity('evan / noel / theo', 'Theo x Acme');
    expect(s).toBeGreaterThan(0); // shares "theo"
    expect(s).toBeLessThan(0.6);
  });

  it('scores unrelated names at/near zero', () => {
    expect(titleSimilarity('banana split', 'quantum physics')).toBe(0);
  });

  it('handles empty / single-char inputs without throwing', () => {
    expect(titleSimilarity('', 'Acme')).toBe(0);
    expect(titleSimilarity('a', 'b')).toBe(0);
  });
});
