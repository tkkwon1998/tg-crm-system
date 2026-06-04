-- Canonical D1 (SQLite) schema for the Telegram -> Attio CRM enrichment system.
-- This file is the source of truth; migrations/0001_init.sql mirrors it exactly.
-- D1 notes: BIGSERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT; JSON stored as TEXT.
-- Timestamps are stored as INTEGER unix epoch seconds (UTC) unless noted.

-- =====================================================================
-- telegram_messages — raw message log. PK (chat_id, message_id) for idempotency.
--   raw_json keeps the full Telethon serialization as the audit trail.
-- =====================================================================
CREATE TABLE IF NOT EXISTS telegram_messages (
  chat_id          INTEGER NOT NULL,            -- Telegram chat/peer id
  message_id       INTEGER NOT NULL,            -- Telegram message id (unique within a chat)
  sender_user_id   INTEGER,                     -- Telegram sender user id (null for some service msgs)
  chat_title       TEXT,                        -- denormalized chat/dialog title for convenience
  text             TEXT,                        -- message text/body (may be empty for media)
  msg_date         INTEGER NOT NULL,            -- message timestamp, unix epoch seconds (UTC)
  is_outgoing      INTEGER NOT NULL DEFAULT 0,  -- 0/1: was this message sent by the account owner
  raw_json         TEXT NOT NULL,               -- full raw message JSON (audit trail)
  extracted_at     INTEGER,                     -- unix seconds when extract pipeline processed it; null = un-extracted
  ingested_at      INTEGER NOT NULL DEFAULT (unixepoch()), -- when this row was written to D1
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_msg_date     ON telegram_messages (msg_date);
CREATE INDEX IF NOT EXISTS idx_messages_sender       ON telegram_messages (sender_user_id);
-- Fast lookup of un-extracted messages for the extract pipeline.
CREATE INDEX IF NOT EXISTS idx_messages_unextracted  ON telegram_messages (chat_id, message_id) WHERE extracted_at IS NULL;

-- =====================================================================
-- chat_cursors — last_message_id per chat; the resume point for catch-up.
-- =====================================================================
CREATE TABLE IF NOT EXISTS chat_cursors (
  chat_id          INTEGER PRIMARY KEY,         -- Telegram chat/peer id
  last_message_id  INTEGER NOT NULL DEFAULT 0,  -- highest message_id ingested so far (the min_id for next fetch)
  chat_title       TEXT,                        -- denormalized title for terminal readability
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- =====================================================================
-- identity_map — durable telegram_user_id <-> attio_record_id resolution.
--   status: unmatched | candidate | confirmed | rejected
--   A confirmed row is never re-matched.
-- =====================================================================
CREATE TABLE IF NOT EXISTS identity_map (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id  INTEGER NOT NULL UNIQUE,    -- one mapping per Telegram user
  attio_record_id   TEXT,                       -- resolved Attio record id; null while unmatched
  status            TEXT NOT NULL DEFAULT 'unmatched'
                      CHECK (status IN ('unmatched','candidate','confirmed','rejected')),
  confidence        REAL NOT NULL DEFAULT 0,    -- 0.0–1.0
  match_method      TEXT,                       -- e.g. 'phone_exact' | 'fuzzy_search' | 'manual' | 'seed'
  candidates_json   TEXT,                       -- JSON array of candidate matches (for review)
  display_name      TEXT,                       -- denormalized Telegram display name for readability
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_identity_status  ON identity_map (status);
CREATE INDEX IF NOT EXISTS idx_identity_attio   ON identity_map (attio_record_id);

-- =====================================================================
-- crm_proposals — Claude's structured suggestions; the review queue.
--   status: pending | approved | applied | rejected
--   Nothing here is truth until applied.
-- =====================================================================
CREATE TABLE IF NOT EXISTS crm_proposals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id    INTEGER,                  -- sender this proposal is about (may be null pre-link)
  attio_object        TEXT NOT NULL DEFAULT 'people', -- Attio object slug, e.g. 'people'
  attio_record_id     TEXT,                     -- target Attio record; null = no confident match (never auto-writes)
  proposed_changes    TEXT NOT NULL,            -- JSON object: { "<attribute_slug>": <value> }
  suggested_action    TEXT NOT NULL DEFAULT 'none'
                        CHECK (suggested_action IN ('bump','follow_up','none')),
  confidence          REAL NOT NULL DEFAULT 0,  -- 0.0–1.0
  rationale           TEXT,                      -- one-line model rationale
  source_message_ids  TEXT NOT NULL,             -- JSON array of "<chat_id>:<message_id>" strings
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','applied','rejected')),
  applied_at          INTEGER,                   -- unix seconds when written to Attio; null until applied
  error               TEXT,                      -- last apply error, if any
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_proposals_status  ON crm_proposals (status);
CREATE INDEX IF NOT EXISTS idx_proposals_record  ON crm_proposals (attio_record_id);
CREATE INDEX IF NOT EXISTS idx_proposals_created ON crm_proposals (created_at);
