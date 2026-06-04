import { describe, it, expect } from 'vitest';
import { parseExtraction } from '../apps/extract/src/claude.js';

describe('parseExtraction — defensive model-output parsing', () => {
  it('parses a clean JSON object', () => {
    const out = parseExtraction(
      JSON.stringify({
        attio_object: 'people',
        attio_record_id: 'rec_1',
        proposed_changes: { email: 'a@b.com' },
        suggested_action: 'bump',
        confidence: 0.8,
        rationale: 'why',
        source_message_ids: ['1:2'],
      })
    );
    expect(out.attio_record_id).toBe('rec_1');
    expect(out.proposed_changes).toEqual({ email: 'a@b.com' });
    expect(out.suggested_action).toBe('bump');
    expect(out.confidence).toBe(0.8);
  });

  it('extracts JSON embedded in prose / markdown fences', () => {
    const raw = 'Sure! Here is the result:\n```json\n{"attio_object":"people","attio_record_id":"rec_9","proposed_changes":{},"suggested_action":"none","confidence":0.3,"rationale":"x","source_message_ids":[]}\n```\nHope that helps.';
    const out = parseExtraction(raw);
    expect(out.attio_record_id).toBe('rec_9');
    expect(out.confidence).toBe(0.3);
  });

  it('handles braces inside string values via balanced scan', () => {
    const raw = '{"attio_object":"people","attio_record_id":null,"proposed_changes":{"note":"a {nested} brace"},"suggested_action":"none","confidence":0.5,"rationale":"has } char","source_message_ids":[]}';
    const out = parseExtraction(raw);
    expect(out.proposed_changes).toEqual({ note: 'a {nested} brace' });
    expect(out.rationale).toBe('has } char');
  });

  it('clamps out-of-range / non-numeric confidence to [0,1]', () => {
    expect(parseExtraction('{"confidence": 5}').confidence).toBe(1);
    expect(parseExtraction('{"confidence": -2}').confidence).toBe(0);
    expect(parseExtraction('{"confidence": "high"}').confidence).toBe(0);
  });

  it('coerces an unknown suggested_action to "none"', () => {
    expect(parseExtraction('{"suggested_action":"maybe"}').suggested_action).toBe('none');
  });

  it('drops non-string source_message_ids', () => {
    const out = parseExtraction('{"source_message_ids":["1:2", 3, null, "4:5"]}');
    expect(out.source_message_ids).toEqual(['1:2', '4:5']);
  });

  it('treats an empty-string record id as null (never a write target)', () => {
    expect(parseExtraction('{"attio_record_id":""}').attio_record_id).toBeNull();
  });

  it('defaults proposed_changes to {} when missing or not an object', () => {
    expect(parseExtraction('{"confidence":0.4}').proposed_changes).toEqual({});
    expect(parseExtraction('{"proposed_changes":[1,2]}').proposed_changes).toEqual({});
  });

  it('returns a zero-confidence no-op fallback on unparseable output', () => {
    const out = parseExtraction('I could not produce JSON for this thread.');
    expect(out.confidence).toBe(0);
    expect(out.attio_record_id).toBeNull();
    expect(out.proposed_changes).toEqual({});
    expect(out.suggested_action).toBe('none');
    expect(out.rationale).toBe('unparseable model output');
  });
});
