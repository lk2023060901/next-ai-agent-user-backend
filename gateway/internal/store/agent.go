package store

import (
	"context"
	"fmt"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

type AgentStore struct {
	db *DB
}

func NewAgentStore(db *DB) *AgentStore {
	return &AgentStore{db: db}
}

var agentColumns = []string{
	"id", "workspace_id", "name", "role", "status", "model", "model_id", "system_prompt",
	"description", "avatar", "color", "identifier", "config_json", "knowledge_bases",
	"created_at", "updated_at",
}

func (s *AgentStore) List(ctx context.Context, workspaceID string) ([]model.Agent, error) {
	rows, err := s.db.Query(ctx,
		Select(agentColumns...).From("agents").
			Where("workspace_id = ?", workspaceID).
			OrderBy("created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer rows.Close()
	return scanAgents(rows)
}

func (s *AgentStore) GetByID(ctx context.Context, id string) (*model.Agent, error) {
	a := &model.Agent{}
	err := s.db.QueryRow(ctx,
		Select(agentColumns...).From("agents").Where("id = ?", id),
	).Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Role, &a.Status, &a.Model, &a.ModelID,
		&a.SystemPrompt, &a.Description, &a.Avatar, &a.Color, &a.Identifier,
		&a.ConfigJSON, &a.KnowledgeBases, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get agent: %w", err)
	}
	return a, nil
}

func (s *AgentStore) Create(ctx context.Context, a *model.Agent) (*model.Agent, error) {
	err := s.db.QueryRow(ctx,
		Insert("agents").
			Columns("workspace_id", "name", "role", "status", "model", "model_id", "system_prompt",
				"description", "avatar", "color", "identifier", "config_json", "knowledge_bases").
			Values(a.WorkspaceID, a.Name, a.Role, a.Status, a.Model, a.ModelID, a.SystemPrompt,
				a.Description, a.Avatar, a.Color, a.Identifier, a.ConfigJSON, a.KnowledgeBases).
			Suffix("RETURNING id, created_at, updated_at"),
	).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create agent: %w", err)
	}
	return a, nil
}

func (s *AgentStore) Update(ctx context.Context, id string, fields map[string]interface{}) (*model.Agent, error) {
	b := SetFields(Update("agents"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", id).
		Suffix("RETURNING " + JoinCols(agentColumns))

	a := &model.Agent{}
	err := s.db.QueryRow(ctx, b).Scan(
		&a.ID, &a.WorkspaceID, &a.Name, &a.Role, &a.Status, &a.Model, &a.ModelID,
		&a.SystemPrompt, &a.Description, &a.Avatar, &a.Color, &a.Identifier,
		&a.ConfigJSON, &a.KnowledgeBases, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("update agent: %w", err)
	}
	return a, nil
}

func (s *AgentStore) Delete(ctx context.Context, id string) error {
	return s.db.Exec(ctx, Delete("agents").Where("id = ?", id))
}

func scanAgents(rows pgx.Rows) ([]model.Agent, error) {
	var agents []model.Agent
	for rows.Next() {
		var a model.Agent
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Role, &a.Status,
			&a.Model, &a.ModelID, &a.SystemPrompt, &a.Description, &a.Avatar,
			&a.Color, &a.Identifier, &a.ConfigJSON, &a.KnowledgeBases,
			&a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
		}
		agents = append(agents, a)
	}
	return agents, nil
}
