-- Migration 0003: system_status heartbeat table.
--
-- Replaces the watchdog's message-age "freshness" check (which false-alarms on
-- quiet accounts — message age tracks Telegram traffic, not system health) with
-- a true LIVENESS signal: each component records when it last ran and whether
-- that run succeeded. The watchdog alerts when ingest stops running or a run
-- fails (real stall / session de-auth), not when the inbox is merely quiet.
-- Also used to persist watchdog alert state for cooldown/dedup.

CREATE TABLE IF NOT EXISTS system_status (
  component   TEXT PRIMARY KEY,            -- 'ingest' | 'watchdog' | ...
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  ok          INTEGER NOT NULL DEFAULT 1,  -- 0/1: did the last run succeed
  detail      TEXT                         -- human-readable or JSON detail
);
