-- AI Providers
CREATE TABLE IF NOT EXISTS ai_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    icon VARCHAR(255) NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    auth_method VARCHAR(50) NOT NULL DEFAULT 'api_key',
    api_key TEXT,
    supports_oauth BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_workspace ON ai_providers(workspace_id);

-- AI Models
CREATE TABLE IF NOT EXISTS ai_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
    series_id VARCHAR(255) NOT NULL DEFAULT '',
    series_name VARCHAR(255) NOT NULL DEFAULT '',
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL DEFAULT '',
    context_window INT NOT NULL DEFAULT 0,
    max_output INT NOT NULL DEFAULT 0,
    input_price DECIMAL(12,6) NOT NULL DEFAULT 0,
    output_price DECIMAL(12,6) NOT NULL DEFAULT 0,
    capabilities TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- Workspace Settings
CREATE TABLE IF NOT EXISTS workspace_settings (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    default_model VARCHAR(255) NOT NULL DEFAULT '',
    default_temperature DECIMAL(3,2) NOT NULL DEFAULT 0.7,
    max_tokens_per_request INT NOT NULL DEFAULT 4096,
    assistant_model_id VARCHAR(255),
    fast_model_id VARCHAR(255),
    code_model_id VARCHAR(255),
    agent_model_id VARCHAR(255),
    sub_agent_model_id VARCHAR(255),
    ocr_provider VARCHAR(255),
    ocr_config JSONB,
    doc_processing_provider VARCHAR(255),
    doc_processing_config JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    prefix VARCHAR(20) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- Usage Records
CREATE TABLE IF NOT EXISTS usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID,
    agent_name VARCHAR(255) NOT NULL DEFAULT '',
    agent_role VARCHAR(50) NOT NULL DEFAULT '',
    provider VARCHAR(255) NOT NULL DEFAULT '',
    model VARCHAR(255) NOT NULL DEFAULT '',
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    duration_ms INT NOT NULL DEFAULT 0,
    cost DECIMAL(12,6) NOT NULL DEFAULT 0,
    success BOOLEAN NOT NULL DEFAULT TRUE,
    scope VARCHAR(50) NOT NULL DEFAULT 'coordinator',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_records_org ON usage_records(org_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_workspace ON usage_records(workspace_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_created ON usage_records(created_at);
