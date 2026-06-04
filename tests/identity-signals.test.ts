import { describe, it, expect } from 'vitest';
import { deriveSignals } from '../apps/extract/src/identity.js';
import type { ThreadMessage } from '../apps/extract/src/env.js';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    chat_id: 1001,
    message_id: 1,
    sender_user_id: 777,
    chat_title: 'Jane Doe',
    text: null,
    msg_date: 1_700_000_000,
    is_outgoing: 0,
    ...over,
  };
}

describe('deriveSignals — deterministic counterparty signals', () => {
  it('uses the chat title as the display name', () => {
    const s = deriveSignals(777, 'Jane Doe', [msg()]);
    expect(s.telegram_user_id).toBe(777);
    expect(s.display_name).toBe('Jane Doe');
  });

  it('extracts and normalizes a phone the counterparty shared', () => {
    const s = deriveSignals(777, 'Jane', [
      msg({ text: 'you can reach me at +1 (415) 555-0199 any time' }),
    ]);
    expect(s.phones).toEqual(['+14155550199']);
  });

  it('ignores phone numbers in OUTGOING (owner) messages', () => {
    const s = deriveSignals(777, 'Jane', [
      msg({ is_outgoing: 1, text: 'my office line is +1 (212) 555-0100' }),
    ]);
    expect(s.phones).toEqual([]);
  });

  it('dedupes the same number across multiple messages', () => {
    const s = deriveSignals(777, 'Jane', [
      msg({ message_id: 1, text: 'call +14155550199' }),
      msg({ message_id: 2, text: 'again: +1-415-555-0199' }),
    ]);
    expect(s.phones).toEqual(['+14155550199']);
  });

  it('returns no phones when the thread has none', () => {
    const s = deriveSignals(777, 'Jane', [msg({ text: 'thanks, talk soon!' })]);
    expect(s.phones).toEqual([]);
  });

  it('skips messages with no text', () => {
    const s = deriveSignals(777, null, [msg({ text: null })]);
    expect(s.phones).toEqual([]);
    expect(s.display_name).toBeNull();
  });
});
