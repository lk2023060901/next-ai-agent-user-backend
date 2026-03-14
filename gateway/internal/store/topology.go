package store

import (
	"context"
	"fmt"
	"time"

	"github.com/nextai-agent/gateway/internal/model"
)

type TopologyStore struct {
	db *DB
}

func NewTopologyStore(db *DB) *TopologyStore {
	return &TopologyStore{db: db}
}

var topologyConnectionColumns = []string{
	"id", "source_agent_id", "target_agent_id", "message_count", "label", "active",
}

func (s *TopologyStore) Get(ctx context.Context, workspaceID string) (*model.TopologyData, error) {
	agents, err := s.listAgents(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	connections, err := s.listConnections(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	tasks, err := s.listTasks(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	return &model.TopologyData{
		Agents:      agents,
		Connections: connections,
		Tasks:       tasks,
	}, nil
}

func (s *TopologyStore) AddConnection(ctx context.Context, workspaceID string, sourceAgentID string, targetAgentID string, label *string) (*model.AgentConnection, error) {
	connection := &model.AgentConnection{}
	err := s.db.QueryRow(ctx,
		Insert("topology_connections").
			Columns("workspace_id", "source_agent_id", "target_agent_id", "label").
			Values(workspaceID, sourceAgentID, targetAgentID, label).
			Suffix("RETURNING "+JoinCols(topologyConnectionColumns)),
	).Scan(
		&connection.ID, &connection.SourceAgentID, &connection.TargetAgentID, &connection.MessageCount,
		&connection.Label, &connection.Active,
	)
	if err != nil {
		return nil, fmt.Errorf("create topology connection: %w", err)
	}
	return connection, nil
}

func (s *TopologyStore) DeleteConnection(ctx context.Context, workspaceID string, connectionID string) error {
	return s.db.Exec(ctx,
		Delete("topology_connections").
			Where("workspace_id = ?", workspaceID).
			Where("id = ?", connectionID),
	)
}

func (s *TopologyStore) listAgents(ctx context.Context, workspaceID string) ([]model.Agent, error) {
	rows, err := s.db.Query(ctx,
		Select(agentColumns...).From("agents").
			Where("workspace_id = ?", workspaceID).
			OrderBy("created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list topology agents: %w", err)
	}
	defer rows.Close()
	return scanAgents(rows)
}

func (s *TopologyStore) listConnections(ctx context.Context, workspaceID string) ([]model.AgentConnection, error) {
	rows, err := s.db.Query(ctx,
		Select(topologyConnectionColumns...).From("topology_connections").
			Where("workspace_id = ?", workspaceID).
			OrderBy("created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list topology connections: %w", err)
	}
	defer rows.Close()

	connections := []model.AgentConnection{}
	for rows.Next() {
		var connection model.AgentConnection
		if err := rows.Scan(
			&connection.ID, &connection.SourceAgentID, &connection.TargetAgentID,
			&connection.MessageCount, &connection.Label, &connection.Active,
		); err != nil {
			return nil, fmt.Errorf("scan topology connection: %w", err)
		}
		connections = append(connections, connection)
	}
	return connections, nil
}

func (s *TopologyStore) listTasks(ctx context.Context, workspaceID string) ([]model.AgentTask, error) {
	rows, err := s.db.Query(ctx,
		Select(
			"id", "name", "description", "instruction", "status", "target_agent_id", "created_at",
			"last_run_at", "next_run_at",
		).
			From("scheduled_tasks").
			Where("workspace_id = ?", workspaceID).
			OrderBy("created_at DESC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list topology tasks: %w", err)
	}
	defer rows.Close()

	tasks := []model.AgentTask{}
	for rows.Next() {
		var (
			taskID        string
			name          string
			description   *string
			instruction   string
			status        string
			targetAgentID *string
			createdAt     time.Time
			lastRunAt     *time.Time
			nextRunAt     *time.Time
		)
		if err := rows.Scan(
			&taskID, &name, &description, &instruction, &status, &targetAgentID, &createdAt,
			&lastRunAt, &nextRunAt,
		); err != nil {
			return nil, fmt.Errorf("scan topology task: %w", err)
		}

		mappedStatus, progress := mapTopologyTaskStatus(status, lastRunAt, nextRunAt)
		desc := instruction
		if description != nil && *description != "" {
			desc = *description
		}

		task := model.AgentTask{
			ID:              taskID,
			Title:           name,
			Description:     desc,
			Status:          mappedStatus,
			Progress:        progress,
			CreatedAt:       createdAt,
			Dependencies:    []string{},
			AssignedAgentID: "",
		}
		if targetAgentID != nil {
			task.AssignedAgentID = *targetAgentID
		}
		if lastRunAt != nil {
			startedAt := *lastRunAt
			task.StartedAt = &startedAt
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

func mapTopologyTaskStatus(status string, lastRunAt *time.Time, nextRunAt *time.Time) (string, int) {
	switch status {
	case "completed":
		return "completed", 100
	case "failed":
		return "failed", 100
	case "blocked", "paused":
		return "blocked", 25
	case "review":
		return "review", 85
	case "running", "in_progress":
		return "in_progress", 50
	case "active":
		if lastRunAt != nil && nextRunAt != nil {
			return "in_progress", 50
		}
		return "assigned", 10
	default:
		return "pending", 0
	}
}
