-- Migration 0002: group-chat -> Attio deal model.
--
-- Pivots enrichment from "DM sender -> person" to "group chat -> deal":
--   * deal_map: durable chat_id <-> attio_deal_id resolution (fuzzy title match,
--     mirrors identity_map's status lifecycle).
--   * crm_proposals gains telegram_chat_id (the originating group) and
--     participants_json (resolved senders to associate as contacts on the deal).
-- identity_map is retained as-is for per-sender (participant) person resolution.

CREATE TABLE IF NOT EXISTS deal_map (
  chat_id         INTEGER PRIMARY KEY,        -- Telegram group chat id (one deal per chat)
  attio_deal_id   TEXT,                       -- resolved Attio deal record id; null while unmatched
  status          TEXT NOT NULL DEFAULT 'unmatched'
                    CHECK (status IN ('unmatched','candidate','confirmed','rejected')),
  confidence      REAL NOT NULL DEFAULT 0,    -- 0.0-1.0
  match_method    TEXT,                       -- 'fuzzy_title' | 'manual' | 'seed'
  candidates_json TEXT,                       -- JSON array of candidate deals (for review)
  chat_title      TEXT,                       -- denormalized chat title
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_deal_map_status ON deal_map (status);
CREATE INDEX IF NOT EXISTS idx_deal_map_deal   ON deal_map (attio_deal_id);

-- crm_proposals: carry the originating chat + resolved participants.
ALTER TABLE crm_proposals ADD COLUMN telegram_chat_id INTEGER;
ALTER TABLE crm_proposals ADD COLUMN participants_json TEXT;

CREATE INDEX IF NOT EXISTS idx_proposals_chat ON crm_proposals (telegram_chat_id);
