CREATE INDEX IF NOT EXISTS idx_topics_cat_live ON topics(status, category, expires_at, created_at DESC);
