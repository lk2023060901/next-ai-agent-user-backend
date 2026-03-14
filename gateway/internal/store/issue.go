package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

var issueIdentifierPattern = regexp.MustCompile(`^[A-Z0-9]+-\d+$`)

var (
	ErrIssueCheckoutConflict = errors.New("issue checkout conflict")
	ErrIssueReleaseConflict  = errors.New("issue release conflict")
)

type IssueStore struct {
	db *DB
}

func NewIssueStore(db *DB) *IssueStore {
	return &IssueStore{db: db}
}

type IssueFilters struct {
	Status          string
	AssigneeAgentID string
	AssigneeUserID  string
	TouchedByUserID string
	UnreadForUserID string
	ProjectID       string
	ParentID        string
	LabelID         string
	Query           string
}

type CreateIssueInput struct {
	WorkspaceID      string
	ProjectID        *string
	GoalID           *string
	ParentID         *string
	Title            string
	Description      *string
	Status           string
	Priority         string
	AssigneeAgentID  *string
	AssigneeUserID   *string
	CreatedByAgentID *string
	CreatedByUserID  *string
	RequestDepth     int
	BillingCode      *string
	LabelIDs         []string
}

type UpdateIssueInput struct {
	ProjectID        *string
	ProjectIDSet     bool
	GoalID           *string
	GoalIDSet        bool
	ParentID         *string
	ParentIDSet      bool
	Title            *string
	Description      *string
	DescriptionSet   bool
	Status           *string
	Priority         *string
	AssigneeAgentID  *string
	AssigneeAgentSet bool
	AssigneeUserID   *string
	AssigneeUserSet  bool
	BillingCode      *string
	BillingCodeSet   bool
	HiddenAt         *time.Time
	HiddenAtSet      bool
	LabelIDs         []string
	LabelIDsSet      bool
}

type CreateIssueLabelInput struct {
	WorkspaceID string
	Name        string
	Color       string
}

type CreateIssueCommentInput struct {
	WorkspaceID   string
	IssueID       string
	AuthorAgentID *string
	AuthorUserID  *string
	Body          string
}

type CreateIssueAttachmentInput struct {
	WorkspaceID      string
	IssueID          string
	IssueCommentID   *string
	ContentType      string
	OriginalFilename *string
	CreatedByAgentID *string
	CreatedByUserID  *string
	Content          []byte
}

type CreateIssueRunInput struct {
	ID                 string
	IssueID            string
	WorkspaceID        string
	AgentID            string
	ExecutionMode      string
	ExecutorName       *string
	ExecutorHostname   *string
	ExecutorPlatform   *string
	Status             string
	TriggerSource      string
	TriggerDetail      *string
	RequestedByUserID  *string
	RequestedByAgentID *string
	HeartbeatAt        *time.Time
	TimeoutAt          *time.Time
	StartedAt          *time.Time
	FinishedAt         *time.Time
	ErrorMessage       *string
	ResultText         *string
	ResultCommentID    *string
}

type UpdateIssueRunInput struct {
	ExecutionMode       *string
	ExecutionModeSet    bool
	ExecutorName        *string
	ExecutorNameSet     bool
	ExecutorHostname    *string
	ExecutorHostnameSet bool
	ExecutorPlatform    *string
	ExecutorPlatformSet bool
	Status              *string
	StartedAt           *time.Time
	StartedAtSet        bool
	FinishedAt          *time.Time
	FinishedAtSet       bool
	ErrorMessage        *string
	ErrorMessageSet     bool
	ResultText          *string
	ResultTextSet       bool
	ResultCommentID     *string
	ResultCommentIDSet  bool
	TriggerDetail       *string
	TriggerDetailSet    bool
	HeartbeatAt         *time.Time
	HeartbeatAtSet      bool
	TimeoutAt           *time.Time
	TimeoutAtSet        bool
}

type CreateApprovalInput struct {
	WorkspaceID        string
	Title              string
	Description        *string
	RequestedByUserID  *string
	RequestedByAgentID *string
}

type UpdateApprovalInput struct {
	Status            *string
	DecisionNote      *string
	DecisionNoteSet   bool
	ResolvedByUserID  *string
	ResolvedByUserSet bool
	ResolvedAt        *time.Time
	ResolvedAtSet     bool
}

type CreateApprovalEventInput struct {
	ApprovalID  string
	WorkspaceID string
	Action      string
	ActorType   string
	ActorID     *string
	Note        *string
	Metadata    map[string]interface{}
}

type CreateIssueRunEventInput struct {
	RunID       string
	IssueID     string
	WorkspaceID string
	Seq         int
	EventType   string
	Payload     map[string]interface{}
}

var issueColumns = []string{
	"id", "workspace_id", "project_id", "goal_id", "parent_id", "title", "description", "status", "priority",
	"assignee_agent_id", "assignee_user_id", "checkout_run_id", "execution_run_id", "execution_agent_name_key", "execution_locked_at",
	"created_by_agent_id", "created_by_user_id", "issue_number", "identifier", "request_depth", "billing_code",
	"started_at", "completed_at", "cancelled_at", "hidden_at", "created_at", "updated_at",
}

var issueLabelColumns = []string{"id", "workspace_id", "name", "color", "created_at", "updated_at"}
var issueCommentColumns = []string{"id", "workspace_id", "issue_id", "author_agent_id", "author_user_id", "body", "created_at", "updated_at"}
var issueAttachmentColumns = []string{
	"id", "workspace_id", "issue_id", "issue_comment_id", "content_type", "byte_size", "sha256", "original_filename",
	"created_by_agent_id", "created_by_user_id", "created_at", "updated_at",
}
var approvalColumns = []string{
	"id", "workspace_id", "title", "description", "status", "requested_by_user_id", "requested_by_agent_id",
	"resolved_by_user_id", "decision_note", "resolved_at", "created_at", "updated_at",
}
var issueRunColumns = []string{
	"id", "issue_id", "workspace_id", "agent_id", "execution_mode", "executor_name", "executor_hostname", "executor_platform", "status", "trigger_source", "trigger_detail", "requested_by_user_id",
	"requested_by_agent_id", "error_message", "result_text", "result_comment_id", "heartbeat_at", "timeout_at", "started_at", "finished_at", "created_at", "updated_at",
}

func (s *IssueStore) List(ctx context.Context, workspaceID string, filters IssueFilters) ([]*model.Issue, error) {
	conditions := []sq.Sqlizer{sq.Eq{"workspace_id": workspaceID}}
	if filters.Status != "" {
		statuses := splitCSV(filters.Status)
		if len(statuses) == 1 {
			conditions = append(conditions, sq.Eq{"status": statuses[0]})
		} else if len(statuses) > 1 {
			conditions = append(conditions, sq.Eq{"status": statuses})
		}
	}
	if filters.AssigneeAgentID != "" {
		conditions = append(conditions, sq.Eq{"assignee_agent_id": filters.AssigneeAgentID})
	}
	if filters.AssigneeUserID != "" {
		conditions = append(conditions, sq.Eq{"assignee_user_id": filters.AssigneeUserID})
	}
	if filters.ProjectID != "" {
		conditions = append(conditions, sq.Eq{"project_id": filters.ProjectID})
	}
	if filters.ParentID != "" {
		conditions = append(conditions, sq.Eq{"parent_id": filters.ParentID})
	}
	if filters.LabelID != "" {
		conditions = append(conditions, sq.Expr("EXISTS (SELECT 1 FROM issue_label_links ill WHERE ill.issue_id = issues.id AND ill.label_id = ?)", filters.LabelID))
	}
	if q := strings.TrimSpace(filters.Query); q != "" {
		pattern := "%" + strings.ReplaceAll(strings.ReplaceAll(q, "%", "\\%"), "_", "\\_") + "%"
		conditions = append(conditions, sq.Expr("(title ILIKE ? OR identifier ILIKE ? OR COALESCE(description, '') ILIKE ? OR EXISTS (SELECT 1 FROM issue_comments ic WHERE ic.issue_id = issues.id AND ic.body ILIKE ?))", pattern, pattern, pattern, pattern))
	}
	if filters.TouchedByUserID != "" {
		conditions = append(conditions, touchedByUserExpr(filters.TouchedByUserID))
	}
	if filters.UnreadForUserID != "" {
		conditions = append(conditions, unreadForUserExpr(filters.UnreadForUserID))
	}

	rows, err := s.db.Query(ctx,
		Select(issueColumns...).From("issues").Where(sq.And(conditions)).OrderBy(priorityOrderExpr(), "updated_at DESC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list issues: %w", err)
	}
	defer rows.Close()
	issues, err := scanIssues(rows)
	if err != nil {
		return nil, err
	}
	if err := s.enrichIssues(ctx, issues, filters.UnreadForUserID); err != nil {
		return nil, err
	}
	return issues, nil
}

func (s *IssueStore) GetByID(ctx context.Context, id string) (*model.Issue, error) {
	issue := &model.Issue{}
	err := s.db.QueryRow(ctx, Select(issueColumns...).From("issues").Where("id = ?", id)).Scan(scanIssueTargets(issue)...)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get issue: %w", err)
	}
	if err := s.enrichIssues(ctx, []*model.Issue{issue}, ""); err != nil {
		return nil, err
	}
	return issue, nil
}

func (s *IssueStore) GetByIdentifier(ctx context.Context, identifier string) (*model.Issue, error) {
	issue := &model.Issue{}
	err := s.db.QueryRow(ctx, Select(issueColumns...).From("issues").Where("identifier = ?", strings.ToUpper(identifier))).Scan(scanIssueTargets(issue)...)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get issue by identifier: %w", err)
	}
	if err := s.enrichIssues(ctx, []*model.Issue{issue}, ""); err != nil {
		return nil, err
	}
	return issue, nil
}

func (s *IssueStore) ResolveID(ctx context.Context, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	if issueIdentifierPattern.MatchString(strings.ToUpper(trimmed)) {
		issue, err := s.GetByIdentifier(ctx, trimmed)
		if err != nil {
			return "", err
		}
		if issue != nil {
			return issue.ID, nil
		}
	}
	return trimmed, nil
}

func (s *IssueStore) Create(ctx context.Context, input CreateIssueInput) (*model.Issue, error) {
	if err := validateIssueAssignee(input.AssigneeAgentID, input.AssigneeUserID); err != nil {
		return nil, err
	}
	status := normalizeIssueStatus(input.Status)
	priority := normalizeIssuePriority(input.Priority)
	if status == "in_progress" && input.AssigneeAgentID == nil && input.AssigneeUserID == nil {
		return nil, fmt.Errorf("in_progress issues require an assignee")
	}

	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin create issue tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var issuePrefix string
	var issueNumber int
	if err := tx.QueryRow(ctx, `UPDATE workspaces SET issue_counter = issue_counter + 1, updated_at = NOW() WHERE id = $1 RETURNING issue_prefix, issue_counter`, input.WorkspaceID).Scan(&issuePrefix, &issueNumber); err != nil {
		return nil, fmt.Errorf("increment issue counter: %w", err)
	}
	identifier := fmt.Sprintf("%s-%d", issuePrefix, issueNumber)

	now := time.Now()
	values := []interface{}{
		input.WorkspaceID, input.ProjectID, input.GoalID, input.ParentID, input.Title, input.Description, status, priority,
		input.AssigneeAgentID, input.AssigneeUserID, input.CreatedByAgentID, input.CreatedByUserID, issueNumber, identifier,
		input.RequestDepth, input.BillingCode, startedAtForStatus(status, now), completedAtForStatus(status, now), cancelledAtForStatus(status, now),
	}
	issue := &model.Issue{}
	query := Insert("issues").Columns(
		"workspace_id", "project_id", "goal_id", "parent_id", "title", "description", "status", "priority",
		"assignee_agent_id", "assignee_user_id", "created_by_agent_id", "created_by_user_id", "issue_number", "identifier",
		"request_depth", "billing_code", "started_at", "completed_at", "cancelled_at",
	).Values(values...).Suffix("RETURNING " + JoinCols(issueColumns))
	sql, args, err := query.ToSql()
	if err != nil {
		return nil, fmt.Errorf("build create issue sql: %w", err)
	}
	if err := tx.QueryRow(ctx, sql, args...).Scan(scanIssueTargets(issue)...); err != nil {
		return nil, fmt.Errorf("create issue: %w", err)
	}
	if len(input.LabelIDs) > 0 {
		if err := syncIssueLabelsTx(ctx, tx, issue.ID, input.LabelIDs); err != nil {
			return nil, err
		}
	}
	if err := insertActivityEventTx(ctx, tx, issue.WorkspaceID, "issue", issue.ID, "issue.created", actorType(input.CreatedByUserID, input.CreatedByAgentID), coalesceID(input.CreatedByUserID, input.CreatedByAgentID), issue.Title, identifier, map[string]interface{}{"identifier": identifier}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit create issue tx: %w", err)
	}
	if err := s.enrichIssues(ctx, []*model.Issue{issue}, ""); err != nil {
		return nil, err
	}
	return issue, nil
}

func (s *IssueStore) Update(ctx context.Context, id string, input UpdateIssueInput) (*model.Issue, error) {
	existing, err := s.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, nil
	}
	nextAssigneeAgentID := existing.AssigneeAgentID
	nextAssigneeUserID := existing.AssigneeUserID
	if input.AssigneeAgentSet {
		nextAssigneeAgentID = input.AssigneeAgentID
	}
	if input.AssigneeUserSet {
		nextAssigneeUserID = input.AssigneeUserID
	}
	if err := validateIssueAssignee(nextAssigneeAgentID, nextAssigneeUserID); err != nil {
		return nil, err
	}
	nextStatus := existing.Status
	if input.Status != nil {
		nextStatus = normalizeIssueStatus(*input.Status)
	}
	if nextStatus == "in_progress" && nextAssigneeAgentID == nil && nextAssigneeUserID == nil {
		return nil, fmt.Errorf("in_progress issues require an assignee")
	}
	now := time.Now()
	fields := map[string]interface{}{"updated_at": now}
	if input.ProjectIDSet {
		fields["project_id"] = input.ProjectID
	}
	if input.GoalIDSet {
		fields["goal_id"] = input.GoalID
	}
	if input.ParentIDSet {
		fields["parent_id"] = input.ParentID
	}
	if input.Title != nil {
		fields["title"] = *input.Title
	}
	if input.DescriptionSet {
		fields["description"] = input.Description
	}
	if input.Priority != nil {
		fields["priority"] = normalizeIssuePriority(*input.Priority)
	}
	if input.AssigneeAgentSet {
		fields["assignee_agent_id"] = input.AssigneeAgentID
	}
	if input.AssigneeUserSet {
		fields["assignee_user_id"] = input.AssigneeUserID
	}
	if input.BillingCodeSet {
		fields["billing_code"] = input.BillingCode
	}
	if input.HiddenAtSet {
		fields["hidden_at"] = input.HiddenAt
	}
	if input.Status != nil {
		fields["status"] = nextStatus
		fields["started_at"] = startedAtTransition(existing.StartedAt, existing.Status, nextStatus, now)
		fields["completed_at"] = completedAtTransition(existing.CompletedAt, nextStatus, now)
		fields["cancelled_at"] = cancelledAtTransition(existing.CancelledAt, nextStatus, now)
		if nextStatus != "in_progress" {
			fields["checkout_run_id"] = nil
		}
	}
	if input.AssigneeAgentSet || input.AssigneeUserSet {
		fields["checkout_run_id"] = nil
	}
	if v, ok := fields["checkout_run_id"]; ok && v == nil {
		fields["execution_run_id"] = nil
		fields["execution_agent_name_key"] = nil
		fields["execution_locked_at"] = nil
	}

	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin update issue tx: %w", err)
	}
	defer tx.Rollback(ctx)

	b := SetFields(Update("issues"), fields).Where("id = ?", id).Suffix("RETURNING " + JoinCols(issueColumns))
	sql, args, err := b.ToSql()
	if err != nil {
		return nil, fmt.Errorf("build update issue sql: %w", err)
	}
	updated := &model.Issue{}
	if err := tx.QueryRow(ctx, sql, args...).Scan(scanIssueTargets(updated)...); err != nil {
		return nil, fmt.Errorf("update issue: %w", err)
	}
	if input.LabelIDsSet {
		if err := syncIssueLabelsTx(ctx, tx, id, input.LabelIDs); err != nil {
			return nil, err
		}
	}
	if err := insertActivityEventTx(ctx, tx, updated.WorkspaceID, "issue", updated.ID, "issue.updated", "user", nil, updated.Title, updated.Identifier, map[string]interface{}{"status": updated.Status}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit update issue tx: %w", err)
	}
	if err := s.enrichIssues(ctx, []*model.Issue{updated}, ""); err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *IssueStore) Remove(ctx context.Context, id string) (*model.Issue, error) {
	issue, err := s.GetByID(ctx, id)
	if err != nil || issue == nil {
		return issue, err
	}
	if err := s.db.Exec(ctx, Delete("issues").Where("id = ?", id)); err != nil {
		return nil, fmt.Errorf("delete issue: %w", err)
	}
	return issue, nil
}

func (s *IssueStore) Checkout(ctx context.Context, issueID, agentID string, expectedStatuses []string, runID string) (*model.Issue, error) {
	now := time.Now()
	statuses := expectedStatuses
	if len(statuses) == 0 {
		statuses = []string{"backlog", "todo", "blocked"}
	}
	b := Update("issues").
		Set("assignee_agent_id", agentID).
		Set("assignee_user_id", nil).
		Set("checkout_run_id", runID).
		Set("execution_run_id", runID).
		Set("execution_locked_at", now).
		Set("status", "in_progress").
		Set("started_at", now).
		Set("updated_at", now).
		Where("id = ?", issueID).
		Where(sq.Eq{"status": statuses}).
		Where(sq.Or{sq.Expr("assignee_agent_id IS NULL"), sq.Expr("assignee_agent_id = ?", agentID)}).
		Where(sq.Or{sq.Expr("checkout_run_id IS NULL"), sq.Expr("checkout_run_id = ?", runID)}).
		Where(sq.Or{sq.Expr("execution_run_id IS NULL"), sq.Expr("execution_run_id = ?", runID)}).
		Suffix("RETURNING " + JoinCols(issueColumns))
	issue := &model.Issue{}
	err := s.db.QueryRow(ctx, b).Scan(scanIssueTargets(issue)...)
	if err == nil {
		if enrichErr := s.enrichIssues(ctx, []*model.Issue{issue}, ""); enrichErr != nil {
			return nil, enrichErr
		}
		return issue, nil
	}
	current, getErr := s.GetByID(ctx, issueID)
	if getErr != nil {
		return nil, getErr
	}
	if current != nil && current.AssigneeAgentID != nil && *current.AssigneeAgentID == agentID && current.Status == "in_progress" && current.CheckoutRunID != nil && *current.CheckoutRunID == runID {
		return current, nil
	}
	return nil, ErrIssueCheckoutConflict
}

func (s *IssueStore) Release(ctx context.Context, issueID, runID string) (*model.Issue, error) {
	now := time.Now()
	b := Update("issues").
		Set("checkout_run_id", nil).
		Set("execution_run_id", nil).
		Set("execution_agent_name_key", nil).
		Set("execution_locked_at", nil).
		Set("updated_at", now).
		Where("id = ?", issueID).
		Where("checkout_run_id = ?", runID).
		Suffix("RETURNING " + JoinCols(issueColumns))
	issue := &model.Issue{}
	err := s.db.QueryRow(ctx, b).Scan(scanIssueTargets(issue)...)
	if err != nil {
		if IsNotFound(err) {
			return nil, ErrIssueReleaseConflict
		}
		return nil, fmt.Errorf("release issue: %w", err)
	}
	if err := s.enrichIssues(ctx, []*model.Issue{issue}, ""); err != nil {
		return nil, err
	}
	return issue, nil
}

func (s *IssueStore) ListLabels(ctx context.Context, workspaceID string) ([]model.IssueLabel, error) {
	rows, err := s.db.Query(ctx, Select(issueLabelColumns...).From("issue_labels").Where("workspace_id = ?", workspaceID).OrderBy("name ASC"))
	if err != nil {
		return nil, fmt.Errorf("list issue labels: %w", err)
	}
	defer rows.Close()
	labels := []model.IssueLabel{}
	for rows.Next() {
		var label model.IssueLabel
		if err := rows.Scan(&label.ID, &label.WorkspaceID, &label.Name, &label.Color, &label.CreatedAt, &label.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan issue label: %w", err)
		}
		labels = append(labels, label)
	}
	return labels, nil
}

func (s *IssueStore) CreateLabel(ctx context.Context, input CreateIssueLabelInput) (*model.IssueLabel, error) {
	label := &model.IssueLabel{}
	b := Insert("issue_labels").Columns("workspace_id", "name", "color").Values(input.WorkspaceID, strings.TrimSpace(input.Name), strings.ToUpper(input.Color)).Suffix("RETURNING " + JoinCols(issueLabelColumns))
	if err := s.db.QueryRow(ctx, b).Scan(&label.ID, &label.WorkspaceID, &label.Name, &label.Color, &label.CreatedAt, &label.UpdatedAt); err != nil {
		return nil, fmt.Errorf("create issue label: %w", err)
	}
	return label, nil
}

func (s *IssueStore) DeleteLabel(ctx context.Context, labelID string) (*model.IssueLabel, error) {
	label := &model.IssueLabel{}
	b := Delete("issue_labels").Where("id = ?", labelID).Suffix("RETURNING " + JoinCols(issueLabelColumns))
	if err := s.db.QueryRow(ctx, b).Scan(&label.ID, &label.WorkspaceID, &label.Name, &label.Color, &label.CreatedAt, &label.UpdatedAt); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("delete issue label: %w", err)
	}
	return label, nil
}

func (s *IssueStore) GetAncestors(ctx context.Context, issueID string) ([]model.IssueAncestor, error) {
	current, err := s.GetByID(ctx, issueID)
	if err != nil || current == nil || current.ParentID == nil {
		return nil, err
	}
	var ancestors []model.IssueAncestor
	parentID := *current.ParentID
	for parentID != "" {
		parent := &model.Issue{}
		err := s.db.QueryRow(ctx, Select(issueColumns...).From("issues").Where("id = ?", parentID)).Scan(scanIssueTargets(parent)...)
		if err != nil {
			if IsNotFound(err) {
				break
			}
			return nil, fmt.Errorf("get issue ancestor: %w", err)
		}
		ancestors = append(ancestors, model.IssueAncestor{
			ID: parent.ID, Identifier: parent.Identifier, Title: parent.Title, Description: parent.Description,
			Status: parent.Status, Priority: parent.Priority, AssigneeAgentID: parent.AssigneeAgentID,
			AssigneeUserID: parent.AssigneeUserID, ProjectID: parent.ProjectID, GoalID: parent.GoalID,
		})
		if parent.ParentID == nil {
			break
		}
		parentID = *parent.ParentID
	}
	for left, right := 0, len(ancestors)-1; left < right; left, right = left+1, right-1 {
		ancestors[left], ancestors[right] = ancestors[right], ancestors[left]
	}
	return ancestors, nil
}

func (s *IssueStore) ListComments(ctx context.Context, issueID string) ([]model.IssueComment, error) {
	rows, err := s.db.Query(ctx, Select(issueCommentColumns...).From("issue_comments").Where("issue_id = ?", issueID).OrderBy("created_at ASC"))
	if err != nil {
		return nil, fmt.Errorf("list issue comments: %w", err)
	}
	defer rows.Close()
	return scanIssueComments(rows)
}

func (s *IssueStore) AddComment(ctx context.Context, input CreateIssueCommentInput) (*model.IssueComment, error) {
	now := time.Now()
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin add issue comment tx: %w", err)
	}
	defer tx.Rollback(ctx)
	comment := &model.IssueComment{}
	b := Insert("issue_comments").Columns("workspace_id", "issue_id", "author_agent_id", "author_user_id", "body").Values(input.WorkspaceID, input.IssueID, input.AuthorAgentID, input.AuthorUserID, input.Body).Suffix("RETURNING " + JoinCols(issueCommentColumns))
	sql, args, err := b.ToSql()
	if err != nil {
		return nil, fmt.Errorf("build add issue comment sql: %w", err)
	}
	if err := tx.QueryRow(ctx, sql, args...).Scan(&comment.ID, &comment.WorkspaceID, &comment.IssueID, &comment.AuthorAgentID, &comment.AuthorUserID, &comment.Body, &comment.CreatedAt, &comment.UpdatedAt); err != nil {
		return nil, fmt.Errorf("add issue comment: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE issues SET updated_at = $2 WHERE id = $1`, input.IssueID, now); err != nil {
		return nil, fmt.Errorf("touch issue after comment: %w", err)
	}
	if err := insertActivityEventTx(ctx, tx, input.WorkspaceID, "issue", input.IssueID, "issue.comment_added", actorType(input.AuthorUserID, input.AuthorAgentID), coalesceID(input.AuthorUserID, input.AuthorAgentID), "Issue comment added", truncateString(input.Body, 160), map[string]interface{}{"commentId": comment.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit add issue comment tx: %w", err)
	}
	return comment, nil
}

func (s *IssueStore) MarkRead(ctx context.Context, workspaceID, issueID, userID string, readAt time.Time) (*model.IssueReadState, error) {
	state := &model.IssueReadState{}
	query := `INSERT INTO issue_read_states (workspace_id, issue_id, user_id, last_read_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW())
		ON CONFLICT (workspace_id, issue_id, user_id)
		DO UPDATE SET last_read_at = EXCLUDED.last_read_at, updated_at = NOW()
		RETURNING workspace_id, issue_id, user_id, last_read_at, updated_at`
	if err := s.db.Pool.QueryRow(ctx, query, workspaceID, issueID, userID, readAt).Scan(&state.WorkspaceID, &state.IssueID, &state.UserID, &state.LastReadAt, &state.UpdatedAt); err != nil {
		return nil, fmt.Errorf("mark issue read: %w", err)
	}
	return state, nil
}

func (s *IssueStore) ListAttachments(ctx context.Context, issueID string) ([]model.IssueAttachment, error) {
	rows, err := s.db.Query(ctx, Select(issueAttachmentColumns...).From("issue_attachments").Where("issue_id = ?", issueID).OrderBy("created_at ASC"))
	if err != nil {
		return nil, fmt.Errorf("list issue attachments: %w", err)
	}
	defer rows.Close()
	attachments := []model.IssueAttachment{}
	for rows.Next() {
		var attachment model.IssueAttachment
		if err := rows.Scan(&attachment.ID, &attachment.WorkspaceID, &attachment.IssueID, &attachment.IssueCommentID, &attachment.ContentType, &attachment.ByteSize, &attachment.SHA256, &attachment.OriginalFilename, &attachment.CreatedByAgentID, &attachment.CreatedByUserID, &attachment.CreatedAt, &attachment.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan issue attachment: %w", err)
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

func (s *IssueStore) GetAttachmentByID(ctx context.Context, attachmentID string) (*model.IssueAttachment, []byte, error) {
	attachment := &model.IssueAttachment{}
	var content []byte
	err := s.db.Pool.QueryRow(ctx, `SELECT id, workspace_id, issue_id, issue_comment_id, content_type, byte_size, sha256, original_filename, created_by_agent_id, created_by_user_id, created_at, updated_at, content FROM issue_attachments WHERE id = $1`, attachmentID).Scan(&attachment.ID, &attachment.WorkspaceID, &attachment.IssueID, &attachment.IssueCommentID, &attachment.ContentType, &attachment.ByteSize, &attachment.SHA256, &attachment.OriginalFilename, &attachment.CreatedByAgentID, &attachment.CreatedByUserID, &attachment.CreatedAt, &attachment.UpdatedAt, &content)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("get issue attachment: %w", err)
	}
	return attachment, content, nil
}

func (s *IssueStore) CreateAttachment(ctx context.Context, input CreateIssueAttachmentInput) (*model.IssueAttachment, error) {
	hash := sha256.Sum256(input.Content)
	sha := hex.EncodeToString(hash[:])
	attachment := &model.IssueAttachment{}
	b := Insert("issue_attachments").Columns(
		"workspace_id", "issue_id", "issue_comment_id", "content_type", "byte_size", "sha256", "original_filename", "created_by_agent_id", "created_by_user_id", "content",
	).Values(input.WorkspaceID, input.IssueID, input.IssueCommentID, input.ContentType, int64(len(input.Content)), sha, input.OriginalFilename, input.CreatedByAgentID, input.CreatedByUserID, input.Content).Suffix("RETURNING " + JoinCols(issueAttachmentColumns))
	if err := s.db.QueryRow(ctx, b).Scan(&attachment.ID, &attachment.WorkspaceID, &attachment.IssueID, &attachment.IssueCommentID, &attachment.ContentType, &attachment.ByteSize, &attachment.SHA256, &attachment.OriginalFilename, &attachment.CreatedByAgentID, &attachment.CreatedByUserID, &attachment.CreatedAt, &attachment.UpdatedAt); err != nil {
		return nil, fmt.Errorf("create issue attachment: %w", err)
	}
	return attachment, nil
}

func (s *IssueStore) RemoveAttachment(ctx context.Context, attachmentID string) (*model.IssueAttachment, error) {
	attachment := &model.IssueAttachment{}
	b := Delete("issue_attachments").Where("id = ?", attachmentID).Suffix("RETURNING " + JoinCols(issueAttachmentColumns))
	if err := s.db.QueryRow(ctx, b).Scan(&attachment.ID, &attachment.WorkspaceID, &attachment.IssueID, &attachment.IssueCommentID, &attachment.ContentType, &attachment.ByteSize, &attachment.SHA256, &attachment.OriginalFilename, &attachment.CreatedByAgentID, &attachment.CreatedByUserID, &attachment.CreatedAt, &attachment.UpdatedAt); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("remove issue attachment: %w", err)
	}
	return attachment, nil
}

func (s *IssueStore) ListApprovals(ctx context.Context, issueID string) ([]model.IssueApproval, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT ia.id, ia.workspace_id, ia.issue_id, ia.approval_id::text, a.title, a.description, a.status,
		a.requested_by_user_id, a.requested_by_agent_id, a.resolved_by_user_id, a.decision_note, a.resolved_at,
		ia.created_by_user_id, ia.created_at, a.updated_at
		FROM issue_approvals ia
		JOIN approvals a ON a.id = ia.approval_id
		WHERE ia.issue_id = $1
		ORDER BY ia.created_at DESC`, issueID)
	if err != nil {
		return nil, fmt.Errorf("list issue approvals: %w", err)
	}
	defer rows.Close()
	approvals := []model.IssueApproval{}
	for rows.Next() {
		var item model.IssueApproval
		if err := rows.Scan(&item.ID, &item.WorkspaceID, &item.IssueID, &item.ApprovalID, &item.Title, &item.Description, &item.Status,
			&item.RequestedByUserID, &item.RequestedByAgentID, &item.ResolvedByUserID, &item.DecisionNote, &item.ResolvedAt,
			&item.CreatedByUserID, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan issue approval: %w", err)
		}
		approvals = append(approvals, item)
	}
	return approvals, nil
}

func (s *IssueStore) LinkApproval(ctx context.Context, workspaceID, issueID, approvalID string, createdByUserID *string) error {
	_, err := s.db.Pool.Exec(ctx, `INSERT INTO issue_approvals (workspace_id, issue_id, approval_id, created_by_user_id) VALUES ($1, $2, $3::uuid, $4) ON CONFLICT (issue_id, approval_id) DO NOTHING`, workspaceID, issueID, approvalID, createdByUserID)
	if err != nil {
		return fmt.Errorf("link issue approval: %w", err)
	}
	return nil
}

func (s *IssueStore) UnlinkApproval(ctx context.Context, issueID, approvalID string) error {
	if _, err := s.db.Pool.Exec(ctx, `DELETE FROM issue_approvals WHERE issue_id = $1 AND approval_id = $2::uuid`, issueID, approvalID); err != nil {
		return fmt.Errorf("unlink issue approval: %w", err)
	}
	return nil
}

func (s *IssueStore) CreateApproval(ctx context.Context, input CreateApprovalInput) (*model.Approval, error) {
	approval := &model.Approval{}
	b := Insert("approvals").
		Columns("workspace_id", "title", "description", "status", "requested_by_user_id", "requested_by_agent_id").
		Values(input.WorkspaceID, strings.TrimSpace(input.Title), input.Description, "pending", input.RequestedByUserID, input.RequestedByAgentID).
		Suffix("RETURNING " + JoinCols(approvalColumns))
	if err := s.db.QueryRow(ctx, b).Scan(scanApprovalTargets(approval)...); err != nil {
		return nil, fmt.Errorf("create approval: %w", err)
	}
	return approval, nil
}

func (s *IssueStore) GetApprovalByID(ctx context.Context, approvalID string) (*model.Approval, error) {
	approval := &model.Approval{}
	err := s.db.QueryRow(ctx, Select(approvalColumns...).From("approvals").Where("id = ?", approvalID)).Scan(scanApprovalTargets(approval)...)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get approval: %w", err)
	}
	return approval, nil
}

func (s *IssueStore) ListApprovalsByWorkspace(ctx context.Context, workspaceID string, status string, limit int) ([]model.Approval, error) {
	if limit <= 0 {
		limit = 50
	}
	q := Select(approvalColumns...).From("approvals").Where("workspace_id = ?", workspaceID).OrderBy("created_at DESC").Limit(uint64(limit))
	if strings.TrimSpace(status) != "" {
		q = q.Where("status = ?", strings.TrimSpace(status))
	}
	rows, err := s.db.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list approvals by workspace: %w", err)
	}
	defer rows.Close()
	var approvals []model.Approval
	for rows.Next() {
		var approval model.Approval
		if err := rows.Scan(scanApprovalTargets(&approval)...); err != nil {
			return nil, fmt.Errorf("scan approval: %w", err)
		}
		approvals = append(approvals, approval)
	}
	return approvals, nil
}

func (s *IssueStore) UpdateApproval(ctx context.Context, approvalID string, input UpdateApprovalInput) (*model.Approval, error) {
	fields := map[string]interface{}{"updated_at": time.Now()}
	if input.Status != nil {
		fields["status"] = normalizeApprovalStatus(*input.Status)
	}
	if input.DecisionNoteSet {
		fields["decision_note"] = input.DecisionNote
	}
	if input.ResolvedByUserSet {
		fields["resolved_by_user_id"] = input.ResolvedByUserID
	}
	if input.ResolvedAtSet {
		fields["resolved_at"] = input.ResolvedAt
	}
	approval := &model.Approval{}
	b := SetFields(Update("approvals"), fields).Where("id = ?", approvalID).Suffix("RETURNING " + JoinCols(approvalColumns))
	if err := s.db.QueryRow(ctx, b).Scan(scanApprovalTargets(approval)...); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("update approval: %w", err)
	}
	return approval, nil
}

func (s *IssueStore) AddApprovalEvent(ctx context.Context, input CreateApprovalEventInput) (*model.ApprovalEvent, error) {
	payloadBytes, err := json.Marshal(input.Metadata)
	if err != nil {
		return nil, fmt.Errorf("marshal approval metadata: %w", err)
	}
	event := &model.ApprovalEvent{}
	var raw []byte
	err = s.db.Pool.QueryRow(ctx, `INSERT INTO approval_events (approval_id, workspace_id, action, actor_type, actor_id, note, metadata_json)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
		RETURNING id, approval_id, workspace_id, action, actor_type, actor_id, note, metadata_json, created_at`,
		input.ApprovalID, input.WorkspaceID, input.Action, input.ActorType, input.ActorID, input.Note, string(payloadBytes)).
		Scan(&event.ID, &event.ApprovalID, &event.WorkspaceID, &event.Action, &event.ActorType, &event.ActorID, &event.Note, &raw, &event.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create approval event: %w", err)
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &event.Metadata)
	}
	return event, nil
}

func (s *IssueStore) ListApprovalEvents(ctx context.Context, approvalID string) ([]model.ApprovalEvent, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT id, approval_id, workspace_id, action, actor_type, actor_id, note, metadata_json, created_at
		FROM approval_events WHERE approval_id = $1::uuid ORDER BY created_at ASC`, approvalID)
	if err != nil {
		return nil, fmt.Errorf("list approval events: %w", err)
	}
	defer rows.Close()
	var events []model.ApprovalEvent
	for rows.Next() {
		var event model.ApprovalEvent
		var raw []byte
		if err := rows.Scan(&event.ID, &event.ApprovalID, &event.WorkspaceID, &event.Action, &event.ActorType, &event.ActorID, &event.Note, &raw, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan approval event: %w", err)
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &event.Metadata)
		}
		events = append(events, event)
	}
	return events, nil
}

func (s *IssueStore) ListLinkedIssueIDsByApproval(ctx context.Context, approvalID string) ([]string, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT issue_id::text FROM issue_approvals WHERE approval_id = $1::uuid`, approvalID)
	if err != nil {
		return nil, fmt.Errorf("list linked issues by approval: %w", err)
	}
	defer rows.Close()
	var issueIDs []string
	for rows.Next() {
		var issueID string
		if err := rows.Scan(&issueID); err != nil {
			return nil, fmt.Errorf("scan linked issue by approval: %w", err)
		}
		issueIDs = append(issueIDs, issueID)
	}
	return issueIDs, nil
}

func (s *IssueStore) CreateRun(ctx context.Context, input CreateIssueRunInput) (*model.IssueRun, error) {
	run := &model.IssueRun{}
	b := Insert("issue_runs").Columns("id", "issue_id", "workspace_id", "agent_id", "execution_mode", "executor_name", "executor_hostname", "executor_platform", "status", "trigger_source", "trigger_detail", "requested_by_user_id", "requested_by_agent_id", "error_message", "result_text", "result_comment_id", "heartbeat_at", "timeout_at", "started_at", "finished_at").Values(input.ID, input.IssueID, input.WorkspaceID, input.AgentID, input.ExecutionMode, input.ExecutorName, input.ExecutorHostname, input.ExecutorPlatform, input.Status, input.TriggerSource, input.TriggerDetail, input.RequestedByUserID, input.RequestedByAgentID, input.ErrorMessage, input.ResultText, input.ResultCommentID, input.HeartbeatAt, input.TimeoutAt, input.StartedAt, input.FinishedAt).Suffix("RETURNING " + JoinCols(issueRunColumns))
	if err := s.db.QueryRow(ctx, b).Scan(scanIssueRunTargets(run)...); err != nil {
		return nil, fmt.Errorf("create issue run: %w", err)
	}
	return run, nil
}

func (s *IssueStore) UpdateRun(ctx context.Context, runID string, input UpdateIssueRunInput) (*model.IssueRun, error) {
	fields := map[string]interface{}{"updated_at": time.Now()}
	if input.ExecutionModeSet {
		fields["execution_mode"] = input.ExecutionMode
	}
	if input.ExecutorNameSet {
		fields["executor_name"] = input.ExecutorName
	}
	if input.ExecutorHostnameSet {
		fields["executor_hostname"] = input.ExecutorHostname
	}
	if input.ExecutorPlatformSet {
		fields["executor_platform"] = input.ExecutorPlatform
	}
	if input.Status != nil {
		fields["status"] = *input.Status
	}
	if input.StartedAtSet {
		fields["started_at"] = input.StartedAt
	}
	if input.FinishedAtSet {
		fields["finished_at"] = input.FinishedAt
	}
	if input.ErrorMessageSet {
		fields["error_message"] = input.ErrorMessage
	}
	if input.ResultTextSet {
		fields["result_text"] = input.ResultText
	}
	if input.ResultCommentIDSet {
		fields["result_comment_id"] = input.ResultCommentID
	}
	if input.TriggerDetailSet {
		fields["trigger_detail"] = input.TriggerDetail
	}
	if input.HeartbeatAtSet {
		fields["heartbeat_at"] = input.HeartbeatAt
	}
	if input.TimeoutAtSet {
		fields["timeout_at"] = input.TimeoutAt
	}
	b := SetFields(Update("issue_runs"), fields).Where("id = ?", runID).Suffix("RETURNING " + JoinCols(issueRunColumns))
	run := &model.IssueRun{}
	if err := s.db.QueryRow(ctx, b).Scan(scanIssueRunTargets(run)...); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("update issue run: %w", err)
	}
	return run, nil
}

func (s *IssueStore) GetRunByID(ctx context.Context, runID string) (*model.IssueRun, error) {
	run := &model.IssueRun{}
	err := s.db.QueryRow(ctx, Select(issueRunColumns...).From("issue_runs").Where("id = ?", runID)).Scan(scanIssueRunTargets(run)...)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get issue run: %w", err)
	}
	return run, nil
}

func (s *IssueStore) ListRunsByIssue(ctx context.Context, issueID string, limit int) ([]model.IssueRun, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, Select(issueRunColumns...).From("issue_runs").Where("issue_id = ?", issueID).OrderBy("created_at DESC").Limit(uint64(limit)))
	if err != nil {
		return nil, fmt.Errorf("list issue runs: %w", err)
	}
	defer rows.Close()
	return scanIssueRuns(rows)
}

func (s *IssueStore) GetActiveRunByIssue(ctx context.Context, issueID string) (*model.IssueRun, error) {
	run := &model.IssueRun{}
	err := s.db.QueryRow(ctx, Select(issueRunColumns...).From("issue_runs").Where("issue_id = ?", issueID).Where(sq.Eq{"status": []string{"pending", "running"}}).OrderBy("created_at DESC").Limit(1)).Scan(scanIssueRunTargets(run)...)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get active issue run: %w", err)
	}
	return run, nil
}

func (s *IssueStore) AddRunEvent(ctx context.Context, input CreateIssueRunEventInput) (*model.IssueRunEvent, error) {
	payloadBytes, err := json.Marshal(input.Payload)
	if err != nil {
		return nil, fmt.Errorf("marshal issue run event payload: %w", err)
	}
	event := &model.IssueRunEvent{}
	var storedPayload []byte
	err = s.db.Pool.QueryRow(ctx, `INSERT INTO issue_run_events (run_id, issue_id, workspace_id, seq, event_type, payload_json) VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (run_id, seq) DO UPDATE SET event_type = EXCLUDED.event_type, payload_json = EXCLUDED.payload_json RETURNING id, run_id, issue_id, workspace_id, seq, event_type, payload_json, created_at`, input.RunID, input.IssueID, input.WorkspaceID, input.Seq, input.EventType, string(payloadBytes)).Scan(&event.ID, &event.RunID, &event.IssueID, &event.WorkspaceID, &event.Seq, &event.EventType, &storedPayload, &event.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create issue run event: %w", err)
	}
	event.Payload = cloneStringAnyMap(input.Payload)
	if len(storedPayload) > 0 {
		_ = json.Unmarshal(storedPayload, &event.Payload)
	}
	return event, nil
}

func (s *IssueStore) ListRunEvents(ctx context.Context, runID string) ([]model.IssueRunEvent, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT id, run_id, issue_id, workspace_id, seq, event_type, payload_json, created_at FROM issue_run_events WHERE run_id = $1 ORDER BY seq ASC`, runID)
	if err != nil {
		return nil, fmt.Errorf("list issue run events: %w", err)
	}
	defer rows.Close()
	var events []model.IssueRunEvent
	for rows.Next() {
		var raw []byte
		var event model.IssueRunEvent
		if err := rows.Scan(&event.ID, &event.RunID, &event.IssueID, &event.WorkspaceID, &event.Seq, &event.EventType, &raw, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan issue run event: %w", err)
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &event.Payload)
		}
		events = append(events, event)
	}
	return events, nil
}

func (s *IssueStore) ListRunEventsAfterSeq(ctx context.Context, runID string, seq int) ([]model.IssueRunEvent, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT id, run_id, issue_id, workspace_id, seq, event_type, payload_json, created_at
		FROM issue_run_events
		WHERE run_id = $1 AND seq > $2
		ORDER BY seq ASC`, runID, seq)
	if err != nil {
		return nil, fmt.Errorf("list issue run events after seq: %w", err)
	}
	defer rows.Close()
	var events []model.IssueRunEvent
	for rows.Next() {
		var raw []byte
		var event model.IssueRunEvent
		if err := rows.Scan(&event.ID, &event.RunID, &event.IssueID, &event.WorkspaceID, &event.Seq, &event.EventType, &raw, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan issue run event after seq: %w", err)
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &event.Payload)
		}
		events = append(events, event)
	}
	return events, nil
}

func (s *IssueStore) SetExecutionLock(ctx context.Context, issueID string, runID string, agentName string) error {
	_, err := s.db.Pool.Exec(ctx, `UPDATE issues SET execution_run_id = $2, execution_agent_name_key = $3, execution_locked_at = NOW(), updated_at = NOW() WHERE id = $1`, issueID, runID, normalizeAgentNameKey(agentName))
	if err != nil {
		return fmt.Errorf("set issue execution lock: %w", err)
	}
	return nil
}

func (s *IssueStore) ClearExecutionLock(ctx context.Context, issueID string, runID string) error {
	_, err := s.db.Pool.Exec(ctx, `UPDATE issues SET execution_run_id = NULL, execution_agent_name_key = NULL, execution_locked_at = NULL, updated_at = NOW() WHERE id = $1 AND execution_run_id = $2`, issueID, runID)
	if err != nil {
		return fmt.Errorf("clear issue execution lock: %w", err)
	}
	return nil
}

func (s *IssueStore) ClearRunLocks(ctx context.Context, issueID string, runID string) error {
	_, err := s.db.Pool.Exec(ctx, `UPDATE issues
		SET checkout_run_id = NULL,
		    execution_run_id = NULL,
		    execution_agent_name_key = NULL,
		    execution_locked_at = NULL,
		    updated_at = NOW()
		WHERE id = $1
		  AND (checkout_run_id = $2 OR execution_run_id = $2)`, issueID, runID)
	if err != nil {
		return fmt.Errorf("clear issue run locks: %w", err)
	}
	return nil
}

func (s *IssueStore) ListTimelineEvents(ctx context.Context, issueID string) ([]model.IssueTimelineEvent, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT id, action, entity_type, entity_id::text, title, description, metadata_json, created_at FROM activity_events WHERE entity_id = $1::uuid ORDER BY created_at ASC`, issueID)
	if err != nil {
		return nil, fmt.Errorf("list issue timeline events: %w", err)
	}
	defer rows.Close()
	var events []model.IssueTimelineEvent
	for rows.Next() {
		var raw []byte
		var event model.IssueTimelineEvent
		if err := rows.Scan(&event.ID, &event.Type, &event.EntityType, &event.EntityID, &event.Title, &event.Description, &raw, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan issue timeline event: %w", err)
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &event.Metadata)
		}
		events = append(events, event)
	}
	return events, nil
}

func (s *IssueStore) AddActivityEvent(ctx context.Context, workspaceID, entityType, entityID, action, actorType string, actorID *string, title, description string, metadata map[string]interface{}) error {
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("marshal activity metadata: %w", err)
	}
	if _, err := s.db.Pool.Exec(ctx, `INSERT INTO activity_events (workspace_id, entity_type, entity_id, action, actor_type, actor_id, title, description, metadata_json)
		VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb)`,
		workspaceID, entityType, entityID, action, actorType, actorID, title, description, string(metadataBytes)); err != nil {
		return fmt.Errorf("insert activity event: %w", err)
	}
	return nil
}

func (s *IssueStore) ExpireStaleRuns(ctx context.Context, staleBefore, now time.Time) ([]model.IssueRun, error) {
	rows, err := s.db.Pool.Query(ctx, `UPDATE issue_runs
		SET status = 'failed',
		    error_message = COALESCE(error_message, 'Issue run heartbeat expired'),
		    finished_at = COALESCE(finished_at, $2),
		    updated_at = $2
		WHERE status IN ('pending', 'running')
		  AND (
		    (timeout_at IS NOT NULL AND timeout_at <= $2)
		    OR (heartbeat_at IS NOT NULL AND heartbeat_at < $1)
		  )
		RETURNING `+JoinCols(issueRunColumns), staleBefore, now)
	if err != nil {
		return nil, fmt.Errorf("expire stale issue runs: %w", err)
	}
	defer rows.Close()
	return scanIssueRuns(rows)
}

func (s *IssueStore) enrichIssues(ctx context.Context, issues []*model.Issue, contextUserID string) error {
	if len(issues) == 0 {
		return nil
	}
	issueIDs := make([]string, 0, len(issues))
	for _, issue := range issues {
		issueIDs = append(issueIDs, issue.ID)
	}
	labelsByIssue, err := s.labelMap(ctx, issueIDs)
	if err != nil {
		return err
	}
	statsByIssue, err := s.commentStatsMap(ctx, issueIDs, contextUserID)
	if err != nil {
		return err
	}
	readsByIssue, err := s.readStateMap(ctx, issueIDs, contextUserID)
	if err != nil {
		return err
	}
	for _, issue := range issues {
		labels := labelsByIssue[issue.ID]
		issue.Labels = labels
		issue.LabelIDs = make([]string, 0, len(labels))
		for _, label := range labels {
			issue.LabelIDs = append(issue.LabelIDs, label.ID)
		}
		if contextUserID == "" {
			continue
		}
		stats := statsByIssue[issue.ID]
		issue.MyLastTouchAt = maxTimePtr(issueCreatedTouch(issue, contextUserID), issueAssignedTouch(issue, contextUserID), readsByIssue[issue.ID], stats.MyLastCommentAt)
		issue.LastExternalCommentAt = stats.LastExternalCommentAt
		if issue.MyLastTouchAt != nil && issue.LastExternalCommentAt != nil {
			issue.IsUnreadForMe = issue.LastExternalCommentAt.After(*issue.MyLastTouchAt)
		}
	}
	return nil
}

type issueCommentStats struct {
	MyLastCommentAt       *time.Time
	LastExternalCommentAt *time.Time
}

func (s *IssueStore) labelMap(ctx context.Context, issueIDs []string) (map[string][]model.IssueLabel, error) {
	result := map[string][]model.IssueLabel{}
	rows, err := s.db.Pool.Query(ctx, `SELECT ill.issue_id, il.id, il.workspace_id, il.name, il.color, il.created_at, il.updated_at FROM issue_label_links ill JOIN issue_labels il ON il.id = ill.label_id WHERE ill.issue_id = ANY($1::uuid[]) ORDER BY il.name ASC`, issueIDs)
	if err != nil {
		return nil, fmt.Errorf("list issue labels map: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var issueID string
		var label model.IssueLabel
		if err := rows.Scan(&issueID, &label.ID, &label.WorkspaceID, &label.Name, &label.Color, &label.CreatedAt, &label.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan issue label map: %w", err)
		}
		result[issueID] = append(result[issueID], label)
	}
	return result, nil
}

func (s *IssueStore) commentStatsMap(ctx context.Context, issueIDs []string, userID string) (map[string]issueCommentStats, error) {
	result := map[string]issueCommentStats{}
	if userID == "" || len(issueIDs) == 0 {
		return result, nil
	}
	rows, err := s.db.Pool.Query(ctx, `SELECT issue_id, MAX(CASE WHEN author_user_id = $2::uuid THEN created_at END), MAX(CASE WHEN author_user_id IS NULL OR author_user_id <> $2::uuid THEN created_at END) FROM issue_comments WHERE issue_id = ANY($1::uuid[]) GROUP BY issue_id`, issueIDs, userID)
	if err != nil {
		return nil, fmt.Errorf("issue comment stats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var issueID string
		var myLast, external *time.Time
		if err := rows.Scan(&issueID, &myLast, &external); err != nil {
			return nil, fmt.Errorf("scan issue comment stats: %w", err)
		}
		result[issueID] = issueCommentStats{MyLastCommentAt: myLast, LastExternalCommentAt: external}
	}
	return result, nil
}

func (s *IssueStore) readStateMap(ctx context.Context, issueIDs []string, userID string) (map[string]*time.Time, error) {
	result := map[string]*time.Time{}
	if userID == "" || len(issueIDs) == 0 {
		return result, nil
	}
	rows, err := s.db.Pool.Query(ctx, `SELECT issue_id, last_read_at FROM issue_read_states WHERE user_id = $2::uuid AND issue_id = ANY($1::uuid[])`, issueIDs, userID)
	if err != nil {
		return nil, fmt.Errorf("issue read state map: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var issueID string
		var readAt *time.Time
		if err := rows.Scan(&issueID, &readAt); err != nil {
			return nil, fmt.Errorf("scan issue read state map: %w", err)
		}
		result[issueID] = readAt
	}
	return result, nil
}

func scanIssues(rows pgx.Rows) ([]*model.Issue, error) {
	issues := []*model.Issue{}
	for rows.Next() {
		issue := &model.Issue{}
		if err := rows.Scan(scanIssueTargets(issue)...); err != nil {
			return nil, fmt.Errorf("scan issue: %w", err)
		}
		issues = append(issues, issue)
	}
	return issues, nil
}

func scanIssueTargets(issue *model.Issue) []interface{} {
	return []interface{}{&issue.ID, &issue.WorkspaceID, &issue.ProjectID, &issue.GoalID, &issue.ParentID, &issue.Title, &issue.Description, &issue.Status, &issue.Priority, &issue.AssigneeAgentID, &issue.AssigneeUserID, &issue.CheckoutRunID, &issue.ExecutionRunID, &issue.ExecutionAgentNameKey, &issue.ExecutionLockedAt, &issue.CreatedByAgentID, &issue.CreatedByUserID, &issue.IssueNumber, &issue.Identifier, &issue.RequestDepth, &issue.BillingCode, &issue.StartedAt, &issue.CompletedAt, &issue.CancelledAt, &issue.HiddenAt, &issue.CreatedAt, &issue.UpdatedAt}
}

func scanIssueComments(rows pgx.Rows) ([]model.IssueComment, error) {
	comments := []model.IssueComment{}
	for rows.Next() {
		var comment model.IssueComment
		if err := rows.Scan(&comment.ID, &comment.WorkspaceID, &comment.IssueID, &comment.AuthorAgentID, &comment.AuthorUserID, &comment.Body, &comment.CreatedAt, &comment.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan issue comment: %w", err)
		}
		comments = append(comments, comment)
	}
	return comments, nil
}

func scanIssueRuns(rows pgx.Rows) ([]model.IssueRun, error) {
	runs := []model.IssueRun{}
	for rows.Next() {
		var run model.IssueRun
		if err := rows.Scan(scanIssueRunTargets(&run)...); err != nil {
			return nil, fmt.Errorf("scan issue run: %w", err)
		}
		runs = append(runs, run)
	}
	return runs, nil
}

func scanIssueRunTargets(run *model.IssueRun) []interface{} {
	return []interface{}{&run.ID, &run.IssueID, &run.WorkspaceID, &run.AgentID, &run.ExecutionMode, &run.ExecutorName, &run.ExecutorHostname, &run.ExecutorPlatform, &run.Status, &run.TriggerSource, &run.TriggerDetail, &run.RequestedByUserID, &run.RequestedByAgentID, &run.ErrorMessage, &run.ResultText, &run.ResultCommentID, &run.HeartbeatAt, &run.TimeoutAt, &run.StartedAt, &run.FinishedAt, &run.CreatedAt, &run.UpdatedAt}
}

func scanApprovalTargets(approval *model.Approval) []interface{} {
	return []interface{}{&approval.ID, &approval.WorkspaceID, &approval.Title, &approval.Description, &approval.Status, &approval.RequestedByUserID, &approval.RequestedByAgentID, &approval.ResolvedByUserID, &approval.DecisionNote, &approval.ResolvedAt, &approval.CreatedAt, &approval.UpdatedAt}
}

func syncIssueLabelsTx(ctx context.Context, tx pgx.Tx, issueID string, labelIDs []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM issue_label_links WHERE issue_id = $1`, issueID); err != nil {
		return fmt.Errorf("clear issue labels: %w", err)
	}
	for _, labelID := range labelIDs {
		if strings.TrimSpace(labelID) == "" {
			continue
		}
		tag, err := tx.Exec(ctx, `INSERT INTO issue_label_links (issue_id, label_id)
			SELECT $1::uuid, il.id
			FROM issue_labels il
			JOIN issues i ON i.id = $1::uuid
			WHERE il.id = $2::uuid AND il.workspace_id = i.workspace_id
			ON CONFLICT DO NOTHING`, issueID, labelID)
		if err != nil {
			return fmt.Errorf("add issue label: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("issue label does not belong to the issue workspace")
		}
	}
	return nil
}

func insertActivityEventTx(ctx context.Context, tx pgx.Tx, workspaceID, entityType, entityID, action, actorType string, actorID *string, title, description string, metadata map[string]interface{}) error {
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("marshal activity metadata: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO activity_events (workspace_id, entity_type, entity_id, action, actor_type, actor_id, title, description, metadata_json) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb)`, workspaceID, entityType, entityID, action, actorType, actorID, title, description, string(metadataBytes)); err != nil {
		return fmt.Errorf("insert activity event: %w", err)
	}
	return nil
}

func validateIssueAssignee(agentID, userID *string) error {
	if agentID != nil && userID != nil {
		return fmt.Errorf("issue can only have one assignee")
	}
	return nil
}

func normalizeIssueStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "todo", "in_progress", "in_review", "blocked", "done", "cancelled":
		return strings.TrimSpace(status)
	default:
		return "backlog"
	}
}

func normalizeIssuePriority(priority string) string {
	switch strings.TrimSpace(priority) {
	case "critical", "high", "low":
		return strings.TrimSpace(priority)
	default:
		return "medium"
	}
}

func normalizeApprovalStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "approved", "rejected", "cancelled":
		return strings.TrimSpace(status)
	default:
		return "pending"
	}
}

func startedAtForStatus(status string, now time.Time) interface{} {
	if status == "in_progress" {
		return now
	}
	return nil
}

func completedAtForStatus(status string, now time.Time) interface{} {
	if status == "done" {
		return now
	}
	return nil
}

func cancelledAtForStatus(status string, now time.Time) interface{} {
	if status == "cancelled" {
		return now
	}
	return nil
}

func startedAtTransition(existing *time.Time, previousStatus, nextStatus string, now time.Time) interface{} {
	if nextStatus == "in_progress" {
		if existing != nil {
			return *existing
		}
		return now
	}
	return nil
}

func completedAtTransition(existing *time.Time, nextStatus string, now time.Time) interface{} {
	if nextStatus == "done" {
		if existing != nil {
			return *existing
		}
		return now
	}
	return nil
}

func cancelledAtTransition(existing *time.Time, nextStatus string, now time.Time) interface{} {
	if nextStatus == "cancelled" {
		if existing != nil {
			return *existing
		}
		return now
	}
	return nil
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func priorityOrderExpr() string {
	return `CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`
}

func touchedByUserExpr(userID string) sq.Sqlizer {
	return sq.Expr(`(created_by_user_id = ?::uuid OR assignee_user_id = ?::uuid OR EXISTS (SELECT 1 FROM issue_read_states rs WHERE rs.issue_id = issues.id AND rs.user_id = ?::uuid) OR EXISTS (SELECT 1 FROM issue_comments ic WHERE ic.issue_id = issues.id AND ic.author_user_id = ?::uuid))`, userID, userID, userID, userID)
}

func unreadForUserExpr(userID string) sq.Sqlizer {
	return sq.Expr(`EXISTS (
		SELECT 1 FROM issue_comments ic
		WHERE ic.issue_id = issues.id
		AND (ic.author_user_id IS NULL OR ic.author_user_id <> ?::uuid)
		AND ic.created_at > GREATEST(
			COALESCE((SELECT MAX(created_at) FROM issue_comments mine WHERE mine.issue_id = issues.id AND mine.author_user_id = ?::uuid), to_timestamp(0)),
			COALESCE((SELECT MAX(last_read_at) FROM issue_read_states rs WHERE rs.issue_id = issues.id AND rs.user_id = ?::uuid), to_timestamp(0)),
			COALESCE(CASE WHEN issues.created_by_user_id = ?::uuid THEN issues.created_at ELSE NULL END, to_timestamp(0)),
			COALESCE(CASE WHEN issues.assignee_user_id = ?::uuid THEN issues.updated_at ELSE NULL END, to_timestamp(0))
		)
	)`, userID, userID, userID, userID, userID)
}

func issueCreatedTouch(issue *model.Issue, userID string) *time.Time {
	if issue.CreatedByUserID != nil && *issue.CreatedByUserID == userID {
		return &issue.CreatedAt
	}
	return nil
}

func issueAssignedTouch(issue *model.Issue, userID string) *time.Time {
	if issue.AssigneeUserID != nil && *issue.AssigneeUserID == userID {
		return &issue.UpdatedAt
	}
	return nil
}

func maxTimePtr(values ...*time.Time) *time.Time {
	var best *time.Time
	for _, value := range values {
		if value == nil {
			continue
		}
		if best == nil || value.After(*best) {
			copy := *value
			best = &copy
		}
	}
	return best
}

func truncateString(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) <= limit {
		return trimmed
	}
	return trimmed[:limit]
}

func actorType(userID, agentID *string) string {
	if userID != nil {
		return "user"
	}
	if agentID != nil {
		return "agent"
	}
	return "system"
}

func coalesceID(primary, fallback *string) *string {
	if primary != nil {
		return primary
	}
	return fallback
}

func normalizeAgentNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func cloneStringAnyMap(input map[string]interface{}) map[string]interface{} {
	if input == nil {
		return map[string]interface{}{}
	}
	copy := make(map[string]interface{}, len(input))
	for key, value := range input {
		copy[key] = value
	}
	return copy
}
