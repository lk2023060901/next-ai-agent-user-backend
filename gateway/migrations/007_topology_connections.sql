CREATE TABLE IF NOT EXISTS topology_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    target_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    label VARCHAR(255),
    message_count INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topology_connections_workspace
    ON topology_connections(workspace_id);

CREATE INDEX IF NOT EXISTS idx_topology_connections_source
    ON topology_connections(source_agent_id);

CREATE INDEX IF NOT EXISTS idx_topology_connections_target
    ON topology_connections(target_agent_id);
