-- Migration 001: Upgrade from initial v1 schema to quality + grounding schema
-- Preserves all existing rows in topics and seen_topics.

ALTER TABLE topics ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN what_happened TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN why_trending TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN key_facts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE topics ADD COLUMN what_to_know_next TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN also_searched TEXT NOT NULL DEFAULT '[]';
ALTER TABLE topics ADD COLUMN source_urls TEXT NOT NULL DEFAULT '[]';
ALTER TABLE topics ADD COLUMN category TEXT NOT NULL DEFAULT 'News';
ALTER TABLE topics ADD COLUMN approx_traffic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN updated_at TEXT;
ALTER TABLE topics ADD COLUMN updates_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE topics ADD COLUMN update_pinged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN last_checked_at TEXT;

CREATE TABLE IF NOT EXISTS pending_topics (
  topic_hash     TEXT PRIMARY KEY,
  topic          TEXT    NOT NULL,
  geo            TEXT    NOT NULL DEFAULT 'US',
  approx_traffic INTEGER NOT NULL DEFAULT 0,
  source_json    TEXT    NOT NULL DEFAULT '[]',
  first_seen_at  TEXT    NOT NULL,
  last_tried_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rejected (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_hash  TEXT NOT NULL,
  topic       TEXT NOT NULL,
  geo         TEXT NOT NULL DEFAULT 'US',
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  rejected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejected(rejected_at);
