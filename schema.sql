-- Ephemeral Trend Site — D1 Schema

CREATE TABLE IF NOT EXISTS topics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slug               TEXT    UNIQUE NOT NULL,
  title              TEXT    NOT NULL,
  body               TEXT    NOT NULL,
  summary            TEXT    NOT NULL DEFAULT '',
  what_happened      TEXT    NOT NULL DEFAULT '',
  why_trending       TEXT    NOT NULL DEFAULT '',
  key_facts          TEXT    NOT NULL DEFAULT '[]',
  what_to_know_next  TEXT    NOT NULL DEFAULT '',
  also_searched      TEXT    NOT NULL DEFAULT '[]',
  bullets            TEXT    NOT NULL DEFAULT '[]',
  sources            TEXT    NOT NULL DEFAULT '',
  source_urls        TEXT    NOT NULL DEFAULT '[]',
  image_url          TEXT    NOT NULL DEFAULT '',
  image_source       TEXT    NOT NULL DEFAULT '',
  category           TEXT    NOT NULL DEFAULT 'News',
  topic              TEXT    NOT NULL,
  geo                TEXT    NOT NULL DEFAULT 'US',
  status             TEXT    NOT NULL DEFAULT 'published',  -- 'published' | 'queued'
  approx_traffic     INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT,
  expires_at         TEXT    NOT NULL,
  updates_json       TEXT    NOT NULL DEFAULT '[]',
  update_pinged      INTEGER NOT NULL DEFAULT 0,
  last_checked_at    TEXT,
  search_hits        INTEGER NOT NULL DEFAULT 0,
  extended           INTEGER NOT NULL DEFAULT 0,
  last_search_hit_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_topics_expires  ON topics(expires_at);
CREATE INDEX IF NOT EXISTS idx_topics_status   ON topics(status, created_at);
CREATE INDEX IF NOT EXISTS idx_topics_extended ON topics(extended, search_hits);

-- Dedup table: remembers every processed/rejected topic for 7 days
CREATE TABLE IF NOT EXISTS seen_topics (
  topic_hash TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  seen_at    TEXT NOT NULL
);

-- Hold queue: topics waiting up to 30 minutes to reach >= 2 distinct outlets
CREATE TABLE IF NOT EXISTS pending_topics (
  topic_hash     TEXT PRIMARY KEY,
  topic          TEXT    NOT NULL,
  geo            TEXT    NOT NULL DEFAULT 'US',
  approx_traffic INTEGER NOT NULL DEFAULT 0,
  source_json    TEXT    NOT NULL DEFAULT '[]',
  first_seen_at  TEXT    NOT NULL,
  last_tried_at  TEXT    NOT NULL
);

-- Audit log of rejected topics for review
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
