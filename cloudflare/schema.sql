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

ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS approval_failed boolean NOT NULL DEFAULT false;

ALTER TABLE cf_approval_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE cf_approval_jobs ADD COLUMN IF NOT EXISTS auto_job boolean NOT NULL DEFAULT false;
ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS auto_eligible boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS cf_bot_settings (
 id integer PRIMARY KEY CHECK (id=1), auto_approval boolean NOT NULL DEFAULT false);
INSERT INTO cf_bot_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE cf_bot_settings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS cf_auto_pending_idx ON join_requests(requested_at,user_id)
 WHERE auto_eligible AND status='pending';
