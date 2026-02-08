-- Hosted sites table for subdomain mapping
-- Replaces KV storage for immediate consistency

CREATE TABLE IF NOT EXISTS hosted_sites (
  project_id TEXT PRIMARY KEY,
  subdomain TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index for fast subdomain lookups
CREATE INDEX IF NOT EXISTS idx_hosted_sites_subdomain ON hosted_sites(subdomain);
