package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
	workflowdef "github.com/nextai-agent/gateway/internal/workflow"
)

var (
	ErrWorkflowNotFound  = errors.New("workflow not found")
	ErrWorkflowNameTaken = errors.New("workflow name already exists")
)

type RevisionConflictError struct {
	CurrentRevision int
}

func (e *RevisionConflictError) Error() string {
	return fmt.Sprintf("workflow revision conflict: current=%d", e.CurrentRevision)
}

type WorkflowStore struct {
	db *DB
}

func NewWorkflowStore(db *DB) *WorkflowStore {
	return &WorkflowStore{db: db}
}

var workflowColumns = []string{
	"id", "workspace_id", "name", "description", "status", "spec_version", "current_revision",
	"created_at", "updated_at",
}

type CreateWorkflowInput struct {
	WorkspaceID string
	Name        string
	Description *string
	Status      string
	Definition  workflowdef.Definition
	Layout      workflowdef.Layout
}

type UpdateWorkflowInput struct {
	Name             *string
	Description      *string
	DescriptionSet   bool
	Status           *string
	ExpectedRevision *int
}

func (s *WorkflowStore) List(ctx context.Context, workspaceID string) ([]model.Workflow, error) {
	rows, err := s.db.Query(ctx,
		Select(workflowColumns...).From("workflows").
			Where("workspace_id = ?", workspaceID).
			OrderBy("updated_at DESC", "created_at DESC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list workflows: %w", err)
	}
	defer rows.Close()
	return scanWorkflows(rows)
}

func (s *WorkflowStore) GetByID(ctx context.Context, workflowID string) (*model.Workflow, error) {
	wf := &model.Workflow{}
	err := s.db.QueryRow(ctx,
		Select(workflowColumns...).From("workflows").Where("id = ?", workflowID),
	).Scan(
		&wf.ID, &wf.WorkspaceID, &wf.Name, &wf.Description, &wf.Status,
		&wf.SpecVersion, &wf.Revision, &wf.CreatedAt, &wf.UpdatedAt,
	)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get workflow: %w", err)
	}
	return wf, nil
}

func (s *WorkflowStore) Create(ctx context.Context, input CreateWorkflowInput) (*model.Workflow, error) {
	if input.Status == "" {
		input.Status = "draft"
	}

	definition := workflowdef.NormalizeDefinition(input.Definition)
	layout := workflowdef.NormalizeLayout(input.Layout)

	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin create workflow tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if taken, err := workflowNameTaken(ctx, tx, input.WorkspaceID, input.Name, ""); err != nil {
		return nil, err
	} else if taken {
		return nil, ErrWorkflowNameTaken
	}

	wf := &model.Workflow{}
	sql, args, err := Insert("workflows").
		Columns("workspace_id", "name", "description", "status", "spec_version", "current_revision").
		Values(input.WorkspaceID, input.Name, input.Description, input.Status, workflowdef.DocumentSpecVersion, 1).
		Suffix("RETURNING " + JoinCols(workflowColumns)).
		ToSql()
	if err != nil {
		return nil, fmt.Errorf("build create workflow sql: %w", err)
	}
	if err := tx.QueryRow(ctx, sql, args...).Scan(
		&wf.ID, &wf.WorkspaceID, &wf.Name, &wf.Description, &wf.Status,
		&wf.SpecVersion, &wf.Revision, &wf.CreatedAt, &wf.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("create workflow: %w", err)
	}

	definitionID, err := upsertWorkflowJSON(ctx, tx, "workflow_definitions", wf.ID, definition.SpecVersion, definition)
	if err != nil {
		return nil, err
	}
	layoutID, err := upsertWorkflowJSON(ctx, tx, "workflow_layouts", wf.ID, layout.SpecVersion, layout)
	if err != nil {
		return nil, err
	}

	sql, args, err = Insert("workflow_revisions").
		Columns("workflow_id", "revision", "definition_id", "layout_id").
		Values(wf.ID, 1, definitionID, layoutID).
		ToSql()
	if err != nil {
		return nil, fmt.Errorf("build create workflow revision sql: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return nil, fmt.Errorf("create workflow revision: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit create workflow tx: %w", err)
	}
	return wf, nil
}

func (s *WorkflowStore) Update(ctx context.Context, workflowID string, input UpdateWorkflowInput) (*model.Workflow, error) {
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin update workflow tx: %w", err)
	}
	defer tx.Rollback(ctx)

	wf, err := getWorkflowForUpdate(ctx, tx, workflowID)
	if err != nil {
		return nil, err
	}

	if input.ExpectedRevision != nil && *input.ExpectedRevision != wf.Revision {
		return nil, &RevisionConflictError{CurrentRevision: wf.Revision}
	}

	if input.Name != nil && *input.Name != wf.Name {
		if taken, err := workflowNameTaken(ctx, tx, wf.WorkspaceID, *input.Name, wf.ID); err != nil {
			return nil, err
		} else if taken {
			return nil, ErrWorkflowNameTaken
		}
	}

	builder := Update("workflows").Set("updated_at", sq.Expr("NOW()")).Where("id = ?", workflowID)
	if input.Name != nil {
		builder = builder.Set("name", *input.Name)
	}
	if input.DescriptionSet {
		builder = builder.Set("description", input.Description)
	}
	if input.Status != nil {
		builder = builder.Set("status", *input.Status)
	}

	sql, args, err := builder.Suffix("RETURNING " + JoinCols(workflowColumns)).ToSql()
	if err != nil {
		return nil, fmt.Errorf("build update workflow sql: %w", err)
	}

	updated := &model.Workflow{}
	if err := tx.QueryRow(ctx, sql, args...).Scan(
		&updated.ID, &updated.WorkspaceID, &updated.Name, &updated.Description, &updated.Status,
		&updated.SpecVersion, &updated.Revision, &updated.CreatedAt, &updated.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("update workflow: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit update workflow tx: %w", err)
	}
	return updated, nil
}

func (s *WorkflowStore) GetDocument(ctx context.Context, workflowID string, revision *int) (*workflowdef.Document, error) {
	var (
		docRevision int
		specVersion string
		updatedAt   time.Time
		defBytes    []byte
		layoutBytes []byte
	)

	var builder sq.SelectBuilder
	if revision == nil {
		builder = Select(
			"w.current_revision", "w.spec_version", "w.updated_at", "wd.content", "wl.content",
		).
			From("workflows w").
			Join("workflow_revisions wr ON wr.workflow_id = w.id AND wr.revision = w.current_revision").
			Join("workflow_definitions wd ON wd.id = wr.definition_id").
			Join("workflow_layouts wl ON wl.id = wr.layout_id").
			Where("w.id = ?", workflowID)
	} else {
		builder = Select(
			"wr.revision", "w.spec_version", "w.updated_at", "wd.content", "wl.content",
		).
			From("workflows w").
			Join("workflow_revisions wr ON wr.workflow_id = w.id").
			Join("workflow_definitions wd ON wd.id = wr.definition_id").
			Join("workflow_layouts wl ON wl.id = wr.layout_id").
			Where("w.id = ?", workflowID).
			Where("wr.revision = ?", *revision)
	}

	err := s.db.QueryRow(ctx, builder).Scan(&docRevision, &specVersion, &updatedAt, &defBytes, &layoutBytes)
	if err != nil {
		if IsNotFound(err) {
			return nil, ErrWorkflowNotFound
		}
		return nil, fmt.Errorf("get workflow document: %w", err)
	}

	var definition workflowdef.Definition
	if err := json.Unmarshal(defBytes, &definition); err != nil {
		return nil, fmt.Errorf("decode workflow definition: %w", err)
	}
	var layout workflowdef.Layout
	if err := json.Unmarshal(layoutBytes, &layout); err != nil {
		return nil, fmt.Errorf("decode workflow layout: %w", err)
	}

	return &workflowdef.Document{
		WorkflowID:  workflowID,
		Revision:    docRevision,
		SpecVersion: specVersion,
		Definition:  workflowdef.NormalizeDefinition(definition),
		Layout:      workflowdef.NormalizeLayout(layout),
		UpdatedAt:   updatedAt,
	}, nil
}

func (s *WorkflowStore) SaveDocument(ctx context.Context, workflowID string, expectedRevision int, definition workflowdef.Definition, layout workflowdef.Layout) (*workflowdef.Document, error) {
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin save workflow document tx: %w", err)
	}
	defer tx.Rollback(ctx)

	wf, err := getWorkflowForUpdate(ctx, tx, workflowID)
	if err != nil {
		return nil, err
	}
	if expectedRevision != wf.Revision {
		return nil, &RevisionConflictError{CurrentRevision: wf.Revision}
	}

	definition = workflowdef.NormalizeDefinition(definition)
	layout = workflowdef.NormalizeLayout(layout)

	definitionID, err := upsertWorkflowJSON(ctx, tx, "workflow_definitions", workflowID, definition.SpecVersion, definition)
	if err != nil {
		return nil, err
	}
	layoutID, err := upsertWorkflowJSON(ctx, tx, "workflow_layouts", workflowID, layout.SpecVersion, layout)
	if err != nil {
		return nil, err
	}

	nextRevision := wf.Revision + 1
	sql, args, err := Insert("workflow_revisions").
		Columns("workflow_id", "revision", "definition_id", "layout_id").
		Values(workflowID, nextRevision, definitionID, layoutID).
		ToSql()
	if err != nil {
		return nil, fmt.Errorf("build save workflow revision sql: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return nil, fmt.Errorf("save workflow revision: %w", err)
	}

	sql, args, err = Update("workflows").
		Set("spec_version", workflowdef.DocumentSpecVersion).
		Set("current_revision", nextRevision).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", workflowID).
		ToSql()
	if err != nil {
		return nil, fmt.Errorf("build update workflow head sql: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return nil, fmt.Errorf("update workflow head: %w", err)
	}

	var updatedAt time.Time
	sql, args, err = Select("updated_at").From("workflows").Where("id = ?", workflowID).ToSql()
	if err != nil {
		return nil, fmt.Errorf("build fetch updated_at sql: %w", err)
	}
	if err := tx.QueryRow(ctx, sql, args...).Scan(&updatedAt); err != nil {
		return nil, fmt.Errorf("fetch workflow updated_at: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit save workflow document tx: %w", err)
	}

	return &workflowdef.Document{
		WorkflowID:  workflowID,
		Revision:    nextRevision,
		SpecVersion: workflowdef.DocumentSpecVersion,
		Definition:  definition,
		Layout:      layout,
		UpdatedAt:   updatedAt,
	}, nil
}

func (s *WorkflowStore) Delete(ctx context.Context, workflowID string) error {
	var deletedID string
	err := s.db.QueryRow(ctx,
		Delete("workflows").
			Where("id = ?", workflowID).
			Suffix("RETURNING id"),
	).Scan(&deletedID)
	if err != nil {
		if IsNotFound(err) {
			return ErrWorkflowNotFound
		}
		return fmt.Errorf("delete workflow: %w", err)
	}
	return nil
}

func upsertWorkflowJSON(ctx context.Context, tx pgx.Tx, table string, workflowID string, specVersion string, payload interface{}) (string, error) {
	content, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal %s payload: %w", table, err)
	}
	hash := hashJSON(content)

	sql, args, err := Insert(table).
		Columns("workflow_id", "spec_version", "content", "content_hash").
		Values(workflowID, specVersion, content, hash).
		Suffix("ON CONFLICT (workflow_id, content_hash) DO UPDATE SET content_hash = EXCLUDED.content_hash RETURNING id").
		ToSql()
	if err != nil {
		return "", fmt.Errorf("build upsert %s sql: %w", table, err)
	}

	var id string
	if err := tx.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
		return "", fmt.Errorf("upsert %s: %w", table, err)
	}
	return id, nil
}

func workflowNameTaken(ctx context.Context, tx pgx.Tx, workspaceID string, name string, excludeWorkflowID string) (bool, error) {
	builder := Select("1").
		From("workflows").
		Where("workspace_id = ?", workspaceID).
		Where("name = ?", name)
	if excludeWorkflowID != "" {
		builder = builder.Where("id <> ?", excludeWorkflowID)
	}
	sql, args, err := builder.Limit(1).ToSql()
	if err != nil {
		return false, fmt.Errorf("build workflow name lookup sql: %w", err)
	}

	var one int
	err = tx.QueryRow(ctx, sql, args...).Scan(&one)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("query workflow name lookup: %w", err)
	}
	return true, nil
}

func getWorkflowForUpdate(ctx context.Context, tx pgx.Tx, workflowID string) (*model.Workflow, error) {
	sql, args, err := Select(workflowColumns...).
		From("workflows").
		Where("id = ?", workflowID).
		Suffix("FOR UPDATE").
		ToSql()
	if err != nil {
		return nil, fmt.Errorf("build workflow lock sql: %w", err)
	}

	wf := &model.Workflow{}
	if err := tx.QueryRow(ctx, sql, args...).Scan(
		&wf.ID, &wf.WorkspaceID, &wf.Name, &wf.Description, &wf.Status,
		&wf.SpecVersion, &wf.Revision, &wf.CreatedAt, &wf.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkflowNotFound
		}
		return nil, fmt.Errorf("lock workflow: %w", err)
	}
	return wf, nil
}

func scanWorkflows(rows pgx.Rows) ([]model.Workflow, error) {
	workflows := []model.Workflow{}
	for rows.Next() {
		var wf model.Workflow
		if err := rows.Scan(
			&wf.ID, &wf.WorkspaceID, &wf.Name, &wf.Description, &wf.Status,
			&wf.SpecVersion, &wf.Revision, &wf.CreatedAt, &wf.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan workflow: %w", err)
		}
		workflows = append(workflows, wf)
	}
	return workflows, nil
}

func hashJSON(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}
