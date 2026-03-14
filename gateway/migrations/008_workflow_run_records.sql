CREATE TABLE IF NOT EXISTS workflow_run_records (
    run_id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    workflow_revision INT,
    status VARCHAR(50) NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_ms INT,
    current_node_id VARCHAR(255),
    paused_at_node_id VARCHAR(255),
    paused_breakpoint_type VARCHAR(32),
    error_message TEXT,
    triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_records_workflow
    ON workflow_run_records(workflow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_run_records_status
    ON workflow_run_records(status, started_at DESC);
