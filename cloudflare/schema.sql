-- Additive only: the existing users and join_requests tables stay intact.
CREATE TABLE IF NOT EXISTS cf_approval_jobs (
 id UUID PRIMARY KEY,status TEXT NOT NULL,total INTEGER NOT NULL,pending_ids JSONB NOT NULL,
 counts JSONB NOT NULL DEFAULT '{"approved":0,"already_inside":0,"resolved":0,"failed":0}',
 errors JSONB NOT NULL DEFAULT '[]',result TEXT NOT NULL DEFAULT '',chat_id TEXT,
 lease_id UUID,lease_until TIMESTAMPTZ,not_before TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS cf_one_approval_job ON cf_approval_jobs(status) WHERE status='running';
CREATE TABLE IF NOT EXISTS cf_updates(update_id BIGINT PRIMARY KEY,done BOOLEAN NOT NULL DEFAULT false,lease_id UUID,lease_until TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE cf_approval_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cf_updates ENABLE ROW LEVEL SECURITY;
