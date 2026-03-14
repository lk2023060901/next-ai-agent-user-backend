CREATE TABLE IF NOT EXISTS workflow_run_outputs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES workflow_run_records(run_id) ON DELETE CASCADE,
    node_id VARCHAR(255) NOT NULL,
    pin_id VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    value_json JSONB NOT NULL DEFAULT 'null'::jsonb,
    mime_type VARCHAR(255),
    media_url TEXT,
    storage_path TEXT,
    file_name TEXT,
    size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(run_id, node_id, pin_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_outputs_run
    ON workflow_run_outputs(run_id, node_id, pin_id);
