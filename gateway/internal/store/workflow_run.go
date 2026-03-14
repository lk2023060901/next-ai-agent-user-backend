package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

var ErrWorkflowRunRecordNotFound = errors.New("workflow run record not found")

type WorkflowRunStore struct {
	db *DB
}

func NewWorkflowRunStore(db *DB) *WorkflowRunStore {
	return &WorkflowRunStore{db: db}
}

var workflowRunRecordColumns = []string{
	"run_id", "workflow_id", "workflow_revision", "status", "started_at", "completed_at", "duration_ms",
	"current_node_id", "paused_at_node_id", "paused_breakpoint_type", "error_message", "triggered_by",
	"created_at", "updated_at",
}

type CreateWorkflowRunRecordInput struct {
	RunID                string
	WorkflowID           string
	WorkflowRevision     *int
	Status               string
	StartedAt            time.Time
	CompletedAt          *time.Time
	CurrentNodeID        *string
	PausedAtNodeID       *string
	PausedBreakpointType *string
	ErrorMessage         *string
	TriggeredBy          *string
}

type UpdateWorkflowRunRecordInput struct {
	Status               *string
	CompletedAt          *time.Time
	CurrentNodeID        *string
	CurrentNodeIDSet     bool
	PausedAtNodeID       *string
	PausedAtNodeIDSet    bool
	PausedBreakpointType *string
	PausedBreakpointSet  bool
	ErrorMessage         *string
	ErrorMessageSet      bool
}

func (s *WorkflowRunStore) Create(ctx context.Context, input CreateWorkflowRunRecordInput) (*model.WorkflowRunRecord, error) {
	var durationValue interface{}
	if input.CompletedAt != nil {
		durationValue = sq.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - ?)) * 1000)::INT", *input.CompletedAt, input.StartedAt)
	}

	builder := Insert("workflow_run_records").
		Columns(
			"run_id", "workflow_id", "workflow_revision", "status", "started_at", "completed_at",
			"duration_ms", "current_node_id", "paused_at_node_id", "paused_breakpoint_type", "error_message", "triggered_by",
		).
		Values(
			input.RunID, input.WorkflowID, input.WorkflowRevision, input.Status, input.StartedAt, input.CompletedAt,
			durationValue,
			input.CurrentNodeID, input.PausedAtNodeID, input.PausedBreakpointType, input.ErrorMessage, input.TriggeredBy,
		)

	record := &model.WorkflowRunRecord{}
	if err := s.db.QueryRow(ctx, builder.Suffix("RETURNING "+JoinCols(workflowRunRecordColumns))).Scan(
		&record.RunID, &record.WorkflowID, &record.WorkflowRevision, &record.Status, &record.StartedAt, &record.CompletedAt,
		&record.DurationMs, &record.CurrentNodeID, &record.PausedAtNodeID, &record.PausedBreakpointType,
		&record.ErrorMessage, &record.TriggeredBy, &record.CreatedAt, &record.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("create workflow run record: %w", err)
	}
	return record, nil
}

func (s *WorkflowRunStore) UpdateState(ctx context.Context, runID string, input UpdateWorkflowRunRecordInput) error {
	builder := Update("workflow_run_records").
		Set("updated_at", sq.Expr("NOW()")).
		Where("run_id = ?", runID)

	if input.Status != nil {
		builder = builder.Set("status", *input.Status)
	}
	if input.CompletedAt != nil {
		builder = builder.Set("completed_at", *input.CompletedAt).
			Set("duration_ms", sq.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at)) * 1000)::INT", *input.CompletedAt))
	}
	if input.CurrentNodeIDSet {
		builder = builder.Set("current_node_id", input.CurrentNodeID)
	}
	if input.PausedAtNodeIDSet {
		builder = builder.Set("paused_at_node_id", input.PausedAtNodeID)
	}
	if input.PausedBreakpointSet {
		builder = builder.Set("paused_breakpoint_type", input.PausedBreakpointType)
	}
	if input.ErrorMessageSet {
		builder = builder.Set("error_message", input.ErrorMessage)
	}

	var returnedRunID string
	if err := s.db.QueryRow(ctx, builder.Suffix("RETURNING run_id")).Scan(&returnedRunID); err != nil {
		if IsNotFound(err) {
			return ErrWorkflowRunRecordNotFound
		}
		return fmt.Errorf("update workflow run record: %w", err)
	}
	return nil
}

func (s *WorkflowRunStore) ListByWorkflow(ctx context.Context, workflowID string, limit int) ([]model.WorkflowRunRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(ctx,
		Select(workflowRunRecordColumns...).
			From("workflow_run_records").
			Where("workflow_id = ?", workflowID).
			OrderBy("started_at DESC").
			Limit(uint64(limit)),
	)
	if err != nil {
		return nil, fmt.Errorf("list workflow run records: %w", err)
	}
	defer rows.Close()
	return scanWorkflowRunRecords(rows)
}

func (s *WorkflowRunStore) GetByRunID(ctx context.Context, runID string) (*model.WorkflowRunRecord, error) {
	record := &model.WorkflowRunRecord{}
	if err := s.db.QueryRow(ctx,
		Select(workflowRunRecordColumns...).
			From("workflow_run_records").
			Where("run_id = ?", runID),
	).Scan(
		&record.RunID, &record.WorkflowID, &record.WorkflowRevision, &record.Status, &record.StartedAt, &record.CompletedAt,
		&record.DurationMs, &record.CurrentNodeID, &record.PausedAtNodeID, &record.PausedBreakpointType,
		&record.ErrorMessage, &record.TriggeredBy, &record.CreatedAt, &record.UpdatedAt,
	); err != nil {
		if IsNotFound(err) {
			return nil, ErrWorkflowRunRecordNotFound
		}
		return nil, fmt.Errorf("get workflow run record: %w", err)
	}
	return record, nil
}

func scanWorkflowRunRecords(rows pgx.Rows) ([]model.WorkflowRunRecord, error) {
	var records []model.WorkflowRunRecord
	for rows.Next() {
		var record model.WorkflowRunRecord
		if err := rows.Scan(
			&record.RunID, &record.WorkflowID, &record.WorkflowRevision, &record.Status, &record.StartedAt, &record.CompletedAt,
			&record.DurationMs, &record.CurrentNodeID, &record.PausedAtNodeID, &record.PausedBreakpointType,
			&record.ErrorMessage, &record.TriggeredBy, &record.CreatedAt, &record.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan workflow run record: %w", err)
		}
		records = append(records, record)
	}
	return records, nil
}
