ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS issue_prefix VARCHAR(32),
    ADD COLUMN IF NOT EXISTS issue_counter INT NOT NULL DEFAULT 0;

UPDATE workspaces
SET issue_prefix = 'WS' || UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 6))
WHERE issue_prefix IS NULL OR issue_prefix = '';

ALTER TABLE workspaces
    ALTER COLUMN issue_prefix SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_issue_prefix ON workspaces(issue_prefix);

CREATE TABLE IF NOT EXISTS issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id UUID,
    goal_id UUID,
    parent_id UUID REFERENCES issues(id) ON DELETE SET NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'backlog',
    priority VARCHAR(32) NOT NULL DEFAULT 'medium',
    assignee_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    checkout_run_id UUID,
    execution_run_id UUID,
    execution_agent_name_key VARCHAR(255),
    execution_locked_at TIMESTAMPTZ,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    issue_number INT NOT NULL,
    identifier VARCHAR(64) NOT NULL,
    request_depth INT NOT NULL DEFAULT 0,
    billing_code VARCHAR(255),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    hidden_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_workspace_status ON issues(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_workspace_parent ON issues(workspace_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_issues_workspace_assignee_agent ON issues(workspace_id, assignee_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_workspace_assignee_user ON issues(workspace_id, assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_workspace_updated ON issues(workspace_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);

CREATE TABLE IF NOT EXISTS issue_labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    color VARCHAR(7) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS issue_label_links (
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES issue_labels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS issue_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue_created ON issue_comments(issue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issue_read_states (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(workspace_id, issue_id, user_id)
);

CREATE TABLE IF NOT EXISTS issue_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    issue_comment_id UUID REFERENCES issue_comments(id) ON DELETE SET NULL,
    content_type VARCHAR(255) NOT NULL,
    byte_size BIGINT NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    original_filename VARCHAR(255),
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_attachments_issue ON issue_attachments(issue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issue_runs (
    id UUID PRIMARY KEY,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    execution_mode VARCHAR(16) NOT NULL DEFAULT 'cloud',
    executor_name VARCHAR(255),
    executor_hostname VARCHAR(255),
    executor_platform VARCHAR(64),
    status VARCHAR(32) NOT NULL,
    trigger_source VARCHAR(64) NOT NULL,
    trigger_detail VARCHAR(255),
    requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    error_message TEXT,
    result_text TEXT,
    result_comment_id UUID REFERENCES issue_comments(id) ON DELETE SET NULL,
    heartbeat_at TIMESTAMPTZ,
    timeout_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_runs_issue_created ON issue_runs(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_runs_issue_status ON issue_runs(issue_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_runs_workspace_status ON issue_runs(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_runs_workspace_mode_status ON issue_runs(workspace_id, execution_mode, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_runs_active_timeout ON issue_runs(status, timeout_at);
CREATE INDEX IF NOT EXISTS idx_issue_runs_active_heartbeat ON issue_runs(status, heartbeat_at);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_issues_checkout_run'
    ) THEN
        ALTER TABLE issues
            ADD CONSTRAINT fk_issues_checkout_run
                FOREIGN KEY (checkout_run_id) REFERENCES issue_runs(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_issues_execution_run'
    ) THEN
        ALTER TABLE issues
            ADD CONSTRAINT fk_issues_execution_run
                FOREIGN KEY (execution_run_id) REFERENCES issue_runs(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS issue_run_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES issue_runs(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    seq INT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_issue_run_events_run_seq ON issue_run_events(run_id, seq);

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

CREATE TABLE IF NOT EXISTS issue_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(issue_id, approval_id)
);

CREATE TABLE IF NOT EXISTS activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    entity_type VARCHAR(32) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(64) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_id UUID,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_workspace_created ON activity_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_entity_created ON activity_events(entity_type, entity_id, created_at DESC);
