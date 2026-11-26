-- Migration 004: Retry counter on pending_topics so transient quality issues don't permanently blacklist topics
ALTER TABLE pending_topics ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
