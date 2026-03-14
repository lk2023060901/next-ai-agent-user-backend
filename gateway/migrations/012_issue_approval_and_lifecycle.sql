ALTER TABLE IF EXISTS issue_runs
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_issue_runs_active_timeout ON issue_runs(status, timeout_at);
CREATE INDEX IF NOT EXISTS idx_issue_runs_active_heartbeat ON issue_runs(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    decision_note TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_workspace_status ON approvals(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_workspace_created ON approvals(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    action VARCHAR(64) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_id UUID,
    note TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_events_approval_created ON approval_events(approval_id, created_at ASC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_issue_approvals_approval'
    ) THEN
        ALTER TABLE issue_approvals
            ADD CONSTRAINT fk_issue_approvals_approval
                FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE CASCADE;
    END IF;
END $$;
