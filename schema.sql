-- Ephemeral Trend Site — D1 Schema

CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    UNIQUE NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  bullets    TEXT    NOT NULL DEFAULT '[]',   -- JSON array of 3 strings
  sources    TEXT    NOT NULL DEFAULT '',     -- comma-separated outlet names
  topic      TEXT    NOT NULL,               -- original RSS topic name
  geo        TEXT    NOT NULL DEFAULT 'US',
  status     TEXT    NOT NULL DEFAULT 'published',  -- 'published' | 'queued'
  created_at TEXT    NOT NULL,               -- ISO 8601
  expires_at TEXT    NOT NULL                -- ISO 8601, created_at + 48h
);

CREATE INDEX IF NOT EXISTS idx_topics_expires ON topics(expires_at);
CREATE INDEX IF NOT EXISTS idx_topics_status  ON topics(status, created_at);

-- Dedup table: remembers every topic we've seen for 7 days
CREATE TABLE IF NOT EXISTS seen_topics (
  topic_hash TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  seen_at    TEXT NOT NULL
);
