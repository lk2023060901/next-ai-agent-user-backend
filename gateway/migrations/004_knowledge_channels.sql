-- Knowledge Bases
CREATE TABLE IF NOT EXISTS knowledge_bases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    document_count INT NOT NULL DEFAULT 0,
    embedding_model VARCHAR(255) NOT NULL DEFAULT '',
    chunk_size INT NOT NULL DEFAULT 512,
    chunk_overlap INT NOT NULL DEFAULT 50,
    requested_document_chunks INT NOT NULL DEFAULT 5,
    document_processing VARCHAR(255),
    reranker_model VARCHAR(255),
    matching_threshold DECIMAL(5,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_workspace ON knowledge_bases(workspace_id);

-- Knowledge Base Documents
CREATE TABLE IF NOT EXISTS kb_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    name VARCHAR(500) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    storage_path TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    chunk_count INT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(kb_id);

-- Channels
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'disconnected',
    connected_channels INT,
    last_active_at TIMESTAMPTZ,
    realtime_connected BOOLEAN NOT NULL DEFAULT FALSE,
    connection_state VARCHAR(255),
    connection_mode VARCHAR(255),
    last_connected_at TIMESTAMPTZ,
    connection_last_error TEXT,
    default_agent_id UUID,
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);

-- Channel Messages
CREATE TABLE IF NOT EXISTS channel_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    direction VARCHAR(20) NOT NULL,
    sender_name VARCHAR(255) NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    agent_id VARCHAR(255),
    agent_name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'success',
    error_detail TEXT,
    processing_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_messages_created ON channel_messages(channel_id, created_at DESC);

-- Routing Rules
CREATE TABLE IF NOT EXISTS routing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    priority INT NOT NULL DEFAULT 0,
    field VARCHAR(50) NOT NULL,
    operator VARCHAR(50) NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    target_agent_id UUID NOT NULL,
    target_agent_name VARCHAR(255) NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_channel ON routing_rules(channel_id);
