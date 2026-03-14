package store

import (
	"context"
	"fmt"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

type ProviderStore struct {
	db *DB
}

func NewProviderStore(db *DB) *ProviderStore {
	return &ProviderStore{db: db}
}

var providerCols = []string{
	"p.id", "p.workspace_id", "p.name", "p.type", "p.icon", "p.base_url",
	"p.auth_method", "p.supports_oauth", "p.enabled", "p.status", "p.created_at",
}

func (s *ProviderStore) List(ctx context.Context, workspaceID string) ([]model.AIProvider, error) {
	rows, err := s.db.Query(ctx,
		Select(append(providerCols, "COALESCE(mc.cnt, 0)")...).
			From("ai_providers p").
			LeftJoin("(SELECT provider_id, COUNT(*) cnt FROM ai_models GROUP BY provider_id) mc ON mc.provider_id = p.id").
			Where("p.workspace_id = ?", workspaceID).
			OrderBy("p.created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list providers: %w", err)
	}
	defer rows.Close()
	return scanProviders(rows)
}

func (s *ProviderStore) Create(ctx context.Context, p *model.AIProvider) (*model.AIProvider, error) {
	err := s.db.QueryRow(ctx,
		Insert("ai_providers").
			Columns("workspace_id", "name", "type", "icon", "base_url", "auth_method", "api_key", "supports_oauth", "enabled", "status").
			Values(p.WorkspaceID, p.Name, p.Type, p.Icon, p.BaseURL, p.AuthMethod, "", p.SupportsOAuth, p.Enabled, "active").
			Suffix("RETURNING id, created_at"),
	).Scan(&p.ID, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create provider: %w", err)
	}
	p.Status = "active"
	p.ModelCount = 0
	return p, nil
}

func (s *ProviderStore) Update(ctx context.Context, id string, fields map[string]interface{}) (*model.AIProvider, error) {
	b := SetFields(Update("ai_providers"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", id).
		Suffix("RETURNING id, workspace_id, name, type, icon, base_url, auth_method, supports_oauth, enabled, status, created_at")

	p := &model.AIProvider{}
	err := s.db.QueryRow(ctx, b).Scan(
		&p.ID, &p.WorkspaceID, &p.Name, &p.Type, &p.Icon, &p.BaseURL,
		&p.AuthMethod, &p.SupportsOAuth, &p.Enabled, &p.Status, &p.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("update provider: %w", err)
	}
	return p, nil
}

func (s *ProviderStore) Delete(ctx context.Context, id string) error {
	return s.db.Exec(ctx, Delete("ai_providers").Where("id = ?", id))
}

// Models

func (s *ProviderStore) ListModels(ctx context.Context, providerID string) ([]model.ModelSeries, error) {
	rows, err := s.db.Query(ctx,
		Select("id", "series_id", "series_name", "name", "display_name", "context_window",
			"max_output", "input_price", "output_price", "capabilities", "enabled").
			From("ai_models").
			Where("provider_id = ?", providerID).
			OrderBy("series_name", "name"),
	)
	if err != nil {
		return nil, fmt.Errorf("list models: %w", err)
	}
	defer rows.Close()

	seriesMap := make(map[string]*model.ModelSeries)
	var seriesOrder []string
	for rows.Next() {
		var m model.AIModel
		var seriesID, seriesName string
		if err := rows.Scan(&m.ID, &seriesID, &seriesName, &m.Name, &m.DisplayName,
			&m.ContextWindow, &m.MaxOutput, &m.InputPrice, &m.OutputPrice,
			&m.Capabilities, &m.Enabled); err != nil {
			return nil, fmt.Errorf("scan model: %w", err)
		}
		if seriesID == "" {
			seriesID = "default"
		}
		if seriesName == "" {
			seriesName = "Models"
		}
		if _, ok := seriesMap[seriesID]; !ok {
			seriesMap[seriesID] = &model.ModelSeries{ID: seriesID, Name: seriesName}
			seriesOrder = append(seriesOrder, seriesID)
		}
		seriesMap[seriesID].Models = append(seriesMap[seriesID].Models, m)
	}

	var result []model.ModelSeries
	for _, sid := range seriesOrder {
		result = append(result, *seriesMap[sid])
	}
	return result, nil
}

func (s *ProviderStore) CreateModel(ctx context.Context, providerID string, m *model.AIModel, seriesID, seriesName string) (*model.AIModel, error) {
	err := s.db.QueryRow(ctx,
		Insert("ai_models").
			Columns("provider_id", "series_id", "series_name", "name", "display_name",
				"context_window", "max_output", "input_price", "output_price", "capabilities", "enabled").
			Values(providerID, seriesID, seriesName, m.Name, m.DisplayName,
				m.ContextWindow, m.MaxOutput, m.InputPrice, m.OutputPrice, m.Capabilities, m.Enabled).
			Suffix("RETURNING id"),
	).Scan(&m.ID)
	if err != nil {
		return nil, fmt.Errorf("create model: %w", err)
	}
	return m, nil
}

func (s *ProviderStore) UpdateModel(ctx context.Context, modelID string, fields map[string]interface{}) (*model.AIModel, error) {
	b := SetFields(Update("ai_models"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", modelID).
		Suffix("RETURNING id, name, display_name, context_window, max_output, input_price, output_price, capabilities, enabled")

	m := &model.AIModel{}
	err := s.db.QueryRow(ctx, b).Scan(
		&m.ID, &m.Name, &m.DisplayName, &m.ContextWindow, &m.MaxOutput,
		&m.InputPrice, &m.OutputPrice, &m.Capabilities, &m.Enabled)
	if err != nil {
		return nil, fmt.Errorf("update model: %w", err)
	}
	return m, nil
}

func (s *ProviderStore) DeleteModel(ctx context.Context, modelID string) error {
	return s.db.Exec(ctx, Delete("ai_models").Where("id = ?", modelID))
}

func (s *ProviderStore) ListAllModels(ctx context.Context, workspaceID string) ([]model.FlatModel, error) {
	rows, err := s.db.Query(ctx,
		Select("m.id", "m.name", "m.display_name", "p.name", "p.icon", "p.type",
			"m.capabilities", "m.context_window", "m.input_price", "m.output_price").
			From("ai_models m").
			Join("ai_providers p ON p.id = m.provider_id").
			Where("p.workspace_id = ? AND p.enabled = true AND m.enabled = true", workspaceID).
			OrderBy("p.name", "m.name"),
	)
	if err != nil {
		return nil, fmt.Errorf("list all models: %w", err)
	}
	defer rows.Close()

	var models []model.FlatModel
	for rows.Next() {
		var fm model.FlatModel
		if err := rows.Scan(&fm.ModelID, &fm.Name, &fm.DisplayName, &fm.ProviderName,
			&fm.ProviderIcon, &fm.ProviderType, &fm.Capabilities, &fm.ContextWindow,
			&fm.InputPrice, &fm.OutputPrice); err != nil {
			return nil, fmt.Errorf("scan flat model: %w", err)
		}
		models = append(models, fm)
	}
	return models, nil
}

// Workspace Settings

func (s *ProviderStore) GetSettings(ctx context.Context, wsID string) (*model.WorkspaceSettings, error) {
	ws := &model.WorkspaceSettings{}
	err := s.db.QueryRow(ctx,
		Select("w.id", "w.name", "COALESCE(w.description, '')",
			"COALESCE(s.default_model, '')", "COALESCE(s.default_temperature, 0.7)",
			"COALESCE(s.max_tokens_per_request, 4096)",
			"s.assistant_model_id", "s.fast_model_id", "s.code_model_id",
			"s.agent_model_id", "s.sub_agent_model_id").
			From("workspaces w").
			LeftJoin("workspace_settings s ON s.workspace_id = w.id").
			Where("w.id = ?", wsID),
	).Scan(&ws.ID, &ws.Name, &ws.Description,
		&ws.DefaultModel, &ws.DefaultTemperature, &ws.MaxTokensPerRequest,
		&ws.AssistantModelID, &ws.FastModelID, &ws.CodeModelID,
		&ws.AgentModelID, &ws.SubAgentModelID)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get settings: %w", err)
	}
	return ws, nil
}

func (s *ProviderStore) UpsertSettings(ctx context.Context, wsID string, fields map[string]interface{}) error {
	// Try update first
	b := SetFields(Update("workspace_settings"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("workspace_id = ?", wsID)

	sql, args, _ := b.ToSql()
	tag, err := s.db.Pool.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("update settings: %w", err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}

	// Insert if not exists
	ins := Insert("workspace_settings").Columns("workspace_id")
	vals := []interface{}{wsID}
	for k, v := range fields {
		ins = ins.Columns(k)
		vals = append(vals, v)
	}
	// Rebuild with values
	ins = psql.Insert("workspace_settings").Columns("workspace_id").Values(wsID)
	for k, v := range fields {
		_ = k
		_ = v
	}
	// Simpler approach: raw upsert
	setClauses := "updated_at = NOW()"
	insertCols := "workspace_id"
	insertVals := fmt.Sprintf("'%s'", wsID)
	i := 1
	upsertArgs := make([]interface{}, 0)
	for k, v := range fields {
		insertCols += ", " + k
		insertVals += fmt.Sprintf(", $%d", i)
		setClauses += fmt.Sprintf(", %s = $%d", k, i)
		upsertArgs = append(upsertArgs, v)
		i++
	}
	query := fmt.Sprintf(
		"INSERT INTO workspace_settings (%s) VALUES (%s) ON CONFLICT (workspace_id) DO UPDATE SET %s",
		insertCols, insertVals, setClauses)
	_, err = s.db.Pool.Exec(ctx, query, upsertArgs...)
	return err
}

// API Keys

func (s *ProviderStore) ListApiKeys(ctx context.Context, wsID string) ([]model.ApiKey, error) {
	rows, err := s.db.Query(ctx,
		Select("id", "name", "prefix", "status", "expires_at", "last_used_at", "created_at").
			From("api_keys").
			Where("workspace_id = ?", wsID).
			OrderBy("created_at DESC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list api keys: %w", err)
	}
	defer rows.Close()

	var keys []model.ApiKey
	for rows.Next() {
		var k model.ApiKey
		if err := rows.Scan(&k.ID, &k.Name, &k.Prefix, &k.Status, &k.ExpiresAt, &k.LastUsedAt, &k.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan api key: %w", err)
		}
		keys = append(keys, k)
	}
	return keys, nil
}

func (s *ProviderStore) CreateApiKey(ctx context.Context, wsID, name, prefix, keyHash string, expiresAt *string) (*model.ApiKey, error) {
	k := &model.ApiKey{}
	b := Insert("api_keys").
		Columns("workspace_id", "name", "prefix", "key_hash", "status").
		Values(wsID, name, prefix, keyHash, "active")

	if expiresAt != nil {
		b = Insert("api_keys").
			Columns("workspace_id", "name", "prefix", "key_hash", "status", "expires_at").
			Values(wsID, name, prefix, keyHash, "active", *expiresAt)
	}

	err := s.db.QueryRow(ctx, b.Suffix("RETURNING id, name, prefix, status, expires_at, last_used_at, created_at")).
		Scan(&k.ID, &k.Name, &k.Prefix, &k.Status, &k.ExpiresAt, &k.LastUsedAt, &k.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create api key: %w", err)
	}
	return k, nil
}

func (s *ProviderStore) DeleteApiKey(ctx context.Context, id string) error {
	return s.db.Exec(ctx, Delete("api_keys").Where("id = ?", id))
}

func scanProviders(rows pgx.Rows) ([]model.AIProvider, error) {
	var providers []model.AIProvider
	for rows.Next() {
		var p model.AIProvider
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.Type, &p.Icon, &p.BaseURL,
			&p.AuthMethod, &p.SupportsOAuth, &p.Enabled, &p.Status, &p.CreatedAt, &p.ModelCount); err != nil {
			return nil, fmt.Errorf("scan provider: %w", err)
		}
		providers = append(providers, p)
	}
	return providers, nil
}
