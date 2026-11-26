-- Migration 002: Add tiered post lifetime columns to existing topics table
-- Keeps all existing data intact.

ALTER TABLE topics ADD COLUMN search_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN extended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN last_search_hit_at TEXT;

CREATE INDEX IF NOT EXISTS idx_topics_extended ON topics(extended, search_hits);
