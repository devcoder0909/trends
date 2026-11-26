-- Composite and cleanup indexes to minimize D1 row reads on free tier
CREATE INDEX IF NOT EXISTS idx_topics_live ON topics(status, expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_topics(seen_at);
CREATE INDEX IF NOT EXISTS idx_pending_first_seen ON pending_topics(first_seen_at);
