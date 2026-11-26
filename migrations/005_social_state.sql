-- Migration 005: key-value state for rate-limited external webhooks (e.g. Make.com Free 1,000 ops/mo)
CREATE TABLE IF NOT EXISTS social_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
