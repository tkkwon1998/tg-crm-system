import { describe, it, expect } from 'vitest';
import { evaluateIngestLiveness, shouldAlert } from '../apps/watchdog/src/index.js';

const NOW = 1_000_000;
const MAX_SILENCE = 600;

describe('evaluateIngestLiveness — liveness, not message recency', () => {
  it('passes when ingest ran recently and the run was OK (even with 0 new messages)', () => {
    const r = evaluateIngestLiveness({ updated_at: NOW - 30, ok: 1, detail: '{"messages_written":0}' }, NOW, MAX_SILENCE);
    expect(r.ok).toBe(true);
  });

  it('does NOT fail just because the inbox is quiet (this was the false-alarm bug)', () => {
    // The heartbeat is 30s old; the newest *message* could be hours old — irrelevant.
    const r = evaluateIngestLiveness({ updated_at: NOW - 30, ok: 1, detail: null }, NOW, MAX_SILENCE);
    expect(r.ok).toBe(true);
  });

  it('fails when the last run errored (session de-auth / container error)', () => {
    const r = evaluateIngestLiveness({ updated_at: NOW - 30, ok: 0, detail: 'session not authorized' }, NOW, MAX_SILENCE);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/de-auth|FAILED/i);
  });

  it('fails when ingest has not run within the silence window (real stall)', () => {
    const r = evaluateIngestLiveness({ updated_at: NOW - 1200, ok: 1, detail: null }, NOW, MAX_SILENCE);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/STALLED/);
  });

  it('fails when there is no heartbeat at all', () => {
    expect(evaluateIngestLiveness(null, NOW, MAX_SILENCE).ok).toBe(false);
  });
});

describe('shouldAlert — cooldown / dedup (anti-spam)', () => {
  const COOLDOWN = 3600;

  it('never alerts when nothing is failing', () => {
    expect(shouldAlert('', { signature: '', lastAlertAt: 0 }, NOW, COOLDOWN)).toBe(false);
  });

  it('alerts immediately on a new/changed failing set', () => {
    expect(shouldAlert('ingest_liveness', { signature: '', lastAlertAt: NOW }, NOW, COOLDOWN)).toBe(true);
    expect(
      shouldAlert('ingest_liveness,queue_depth', { signature: 'ingest_liveness', lastAlertAt: NOW }, NOW, COOLDOWN)
    ).toBe(true);
  });

  it('suppresses a repeat of the SAME failure within the cooldown', () => {
    expect(
      shouldAlert('ingest_liveness', { signature: 'ingest_liveness', lastAlertAt: NOW - 300 }, NOW, COOLDOWN)
    ).toBe(false); // 5 min < 1h cooldown -> the every-5-min spam is gone
  });

  it('re-alerts the same failure once the cooldown elapses', () => {
    expect(
      shouldAlert('ingest_liveness', { signature: 'ingest_liveness', lastAlertAt: NOW - 4000 }, NOW, COOLDOWN)
    ).toBe(true);
  });
});
