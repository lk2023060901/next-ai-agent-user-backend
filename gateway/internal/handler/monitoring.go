package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	sq "github.com/Masterminds/squirrel"
	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var monLog = logger.Named("monitoring")

type MonitoringHandler struct {
	db     *store.DB
	issues *store.IssueStore
}

func NewMonitoringHandler(db *store.DB, issues *store.IssueStore) *MonitoringHandler {
	return &MonitoringHandler{db: db, issues: issues}
}

func (h *MonitoringHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/monitoring/runs", h.ListRuns)
	r.Get("/monitoring/runs/{runId}/status", h.RunStatus)
	r.Get("/monitoring/runs/{runId}/logs", h.RunLogs)
}

func (h *MonitoringHandler) ListRuns(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(chi.URLParam(r, "wsId"))
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "workspaceId is required")
		return
	}
	if h.issues != nil {
		if err := NewIssueRuntimeBridge("", h.issues, nil).ReconcileStaleRuns(r.Context(), workspaceID); err != nil {
			monLog.Warn("reconcile stale issue runs before monitoring list failed", zap.String("workspaceId", workspaceID), zap.Error(err))
		}
	}
	limit, err := monitoringLimit(r.URL.Query().Get("limit"), 50, 200)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	offset, err := monitoringOffset(r.URL.Query().Get("offset"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	sortMode, err := monitoringSort(r.URL.Query().Get("sort"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	activeOnly, activeSet, err := monitoringActive(r.URL.Query().Get("active"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	statuses := monitoringStatuses(r.URL.Query().Get("status"))
	if len(statuses) == 0 && (!activeSet || activeOnly) {
		statuses = []string{"pending", "running"}
	}
	executionMode, modeSet, err := monitoringExecutionMode(r.URL.Query().Get("executionMode"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	options := monitoringQueryOptions{
		WorkspaceID:      workspaceID,
		Statuses:         statuses,
		ExecutionMode:    executionMode,
		ExecutionModeSet: modeSet,
		AgentID:          strings.TrimSpace(r.URL.Query().Get("agentId")),
		IssueID:          strings.TrimSpace(r.URL.Query().Get("issueId")),
		Limit:            limit,
		Offset:           offset,
		Sort:             sortMode,
	}
	runs, err := h.queryRuns(r.Context(), options)
	if err != nil {
		monLog.Error("list monitoring runs failed", zap.String("workspaceId", workspaceID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取执行中的 issue runs 失败")
		return
	}
	if runs == nil {
		runs = []model.MonitoringRun{}
	}
	total, err := h.countRuns(r.Context(), options)
	if err != nil {
		monLog.Error("count monitoring runs failed", zap.String("workspaceId", workspaceID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "统计 issue runs 失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"data":    runs,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
		"hasMore": int(offset)+len(runs) < total,
	})
}

func (h *MonitoringHandler) RunStatus(w http.ResponseWriter, r *http.Request) {
	runID := strings.TrimSpace(chi.URLParam(r, "runId"))
	if runID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "runId is required")
		return
	}
	if h.issues != nil {
		if run, err := h.issues.GetRunByID(r.Context(), runID); err == nil && run != nil {
			if reconcileErr := NewIssueRuntimeBridge("", h.issues, nil).ReconcileStaleRuns(r.Context(), run.WorkspaceID); reconcileErr != nil {
				monLog.Warn("reconcile stale issue runs before monitoring status failed", zap.String("runId", runID), zap.Error(reconcileErr))
			}
		}
	}

	runs, err := h.queryRuns(r.Context(), monitoringQueryOptions{RunID: runID, Limit: 1, Sort: "recent"})
	if err != nil {
		monLog.Error("get monitoring run status failed", zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue run 状态失败")
		return
	}
	if len(runs) == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue run 不存在")
		return
	}
	writeData(w, runs[0])
}

func (h *MonitoringHandler) RunLogs(w http.ResponseWriter, r *http.Request) {
	runID := strings.TrimSpace(chi.URLParam(r, "runId"))
	if runID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "runId is required")
		return
	}
	if h.issues != nil {
		if run, err := h.issues.GetRunByID(r.Context(), runID); err == nil && run != nil {
			if reconcileErr := NewIssueRuntimeBridge("", h.issues, nil).ReconcileStaleRuns(r.Context(), run.WorkspaceID); reconcileErr != nil {
				monLog.Warn("reconcile stale issue runs before monitoring logs failed", zap.String("runId", runID), zap.Error(reconcileErr))
			}
		}
	}
	limit, err := monitoringLimit(r.URL.Query().Get("limit"), 200, 500)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}

	rows, err := h.db.Pool.Query(r.Context(), `SELECT id, run_id, issue_id, workspace_id, seq, event_type, payload_json, created_at
		FROM issue_run_events
		WHERE run_id = $1
		ORDER BY seq ASC
		LIMIT $2`, runID, limit)
	if err != nil {
		monLog.Error("get monitoring run logs failed", zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue run 日志失败")
		return
	}
	defer rows.Close()

	events := make([]model.IssueRunEvent, 0)
	run, _ := h.fetchRunForMonitoring(r.Context(), runID)
	for rows.Next() {
		var raw []byte
		var event model.IssueRunEvent
		if err := rows.Scan(&event.ID, &event.RunID, &event.IssueID, &event.WorkspaceID, &event.Seq, &event.EventType, &raw, &event.CreatedAt); err != nil {
			monLog.Error("scan monitoring run log failed", zap.String("runId", runID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 issue run 日志失败")
			return
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &event.Payload)
		}
		hydrateIssueRunEvent(&event, run)
		events = append(events, event)
	}

	if len(events) == 0 {
		exists, err := h.issueRunExists(r.Context(), runID)
		if err != nil {
			monLog.Error("check issue run existence failed", zap.String("runId", runID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 issue run 日志失败")
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "issue run 不存在")
			return
		}
	}

	writeData(w, events)
}

func (h *MonitoringHandler) fetchRunForMonitoring(ctx context.Context, runID string) (*model.IssueRun, error) {
	if h.issues == nil {
		return nil, nil
	}
	return h.issues.GetRunByID(ctx, runID)
}

type monitoringQueryOptions struct {
	WorkspaceID      string
	RunID            string
	Statuses         []string
	ExecutionMode    string
	ExecutionModeSet bool
	AgentID          string
	IssueID          string
	Limit            int
	Offset           uint64
	Sort             string
}

func applyMonitoringRunFilters(query sq.SelectBuilder, options monitoringQueryOptions) sq.SelectBuilder {
	if options.WorkspaceID != "" {
		query = query.Where("ir.workspace_id = ?", options.WorkspaceID)
	}
	if options.RunID != "" {
		query = query.Where("ir.id = ?", options.RunID)
	}
	if len(options.Statuses) == 1 {
		query = query.Where("ir.status = ?", options.Statuses[0])
	} else if len(options.Statuses) > 1 {
		query = query.Where(sq.Eq{"ir.status": options.Statuses})
	}
	if options.ExecutionModeSet {
		query = query.Where("ir.execution_mode = ?", options.ExecutionMode)
	}
	if options.AgentID != "" {
		query = query.Where(sq.Or{
			sq.Expr("ir.agent_id = ?", options.AgentID),
			sq.Expr("a.identifier = ?", options.AgentID),
		})
	}
	if options.IssueID != "" {
		query = query.Where(sq.Or{
			sq.Expr("ir.issue_id = ?", options.IssueID),
			sq.Expr("i.identifier = ?", strings.ToUpper(options.IssueID)),
		})
	}
	return query
}

func (h *MonitoringHandler) queryRuns(ctx context.Context, options monitoringQueryOptions) ([]model.MonitoringRun, error) {
	if options.Limit <= 0 {
		options.Limit = 50
	}
	if options.Sort == "" {
		options.Sort = "active"
	}
	query := store.Select(
		"ir.id",
		"ir.issue_id",
		"ir.workspace_id",
		"i.identifier",
		"i.title",
		"i.status",
		"ir.agent_id",
		"a.name",
		"ir.status",
		"ir.execution_mode",
		"ir.executor_name",
		"ir.executor_hostname",
		"ir.executor_platform",
		"ir.trigger_source",
		"ir.trigger_detail",
		"le.event_type",
		"le.payload_json",
		"le.created_at",
		"ir.error_message",
		"ir.result_text",
		"ir.started_at",
		"ir.finished_at",
		"ir.created_at",
		"ir.updated_at",
	).
		From("issue_runs ir").
		Join("issues i ON i.id = ir.issue_id").
		Join("agents a ON a.id = ir.agent_id").
		LeftJoin(`LATERAL (
			SELECT ire.event_type, ire.payload_json, ire.created_at
			FROM issue_run_events ire
			WHERE ire.run_id = ir.id
			ORDER BY ire.seq DESC
			LIMIT 1
		) le ON TRUE`)
	query = applyMonitoringRunFilters(query, options)

	query = query.OrderBy(monitoringOrderBy(options.Sort)...).Limit(uint64(options.Limit))
	if options.Offset > 0 {
		query = query.Offset(options.Offset)
	}

	rows, err := h.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	runs := make([]model.MonitoringRun, 0)
	for rows.Next() {
		var item model.MonitoringRun
		var rawPayload []byte
		if err := rows.Scan(
			&item.RunID,
			&item.IssueID,
			&item.WorkspaceID,
			&item.IssueIdentifier,
			&item.IssueTitle,
			&item.IssueStatus,
			&item.AgentID,
			&item.AgentName,
			&item.Status,
			&item.ExecutionMode,
			&item.ExecutorName,
			&item.ExecutorHostname,
			&item.ExecutorPlatform,
			&item.TriggerSource,
			&item.TriggerDetail,
			&item.LastEventType,
			&rawPayload,
			&item.LastEventAt,
			&item.ErrorMessage,
			&item.ResultText,
			&item.StartedAt,
			&item.FinishedAt,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		item.Summary = monitoringSummary(item.IssueIdentifier, item.IssueTitle)
		item.LastEventSummary = monitoringEventSummary(item.LastEventType, rawPayload, item.Status, item.ErrorMessage, item.ResultText)
		item.CurrentStep = monitoringCurrentStep(item.Status, item.LastEventType, item.LastEventSummary)
		runs = append(runs, item)
	}
	return runs, nil
}

func (h *MonitoringHandler) countRuns(ctx context.Context, options monitoringQueryOptions) (int, error) {
	query := applyMonitoringRunFilters(
		store.Select("COUNT(*)").
			From("issue_runs ir").
			Join("issues i ON i.id = ir.issue_id").
			Join("agents a ON a.id = ir.agent_id"),
		options,
	)
	var total int
	if err := h.db.QueryRow(ctx, query).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

func (h *MonitoringHandler) issueRunExists(ctx context.Context, runID string) (bool, error) {
	var exists bool
	if err := h.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM issue_runs WHERE id = $1)`, runID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

func monitoringLimit(raw string, defaultValue, maxValue int) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultValue, nil
	}
	limit, err := strconv.Atoi(trimmed)
	if err != nil || limit <= 0 {
		return 0, fmt.Errorf("limit must be a positive integer")
	}
	if limit > maxValue {
		return maxValue, nil
	}
	return limit, nil
}

func monitoringStatuses(raw string) []string {
	parts := strings.Split(raw, ",")
	statuses := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			statuses = append(statuses, trimmed)
		}
	}
	return statuses
}

func monitoringExecutionMode(raw string) (string, bool, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false, nil
	}
	return normalizeExecutionMode(&trimmed)
}

func monitoringActive(raw string) (bool, bool, error) {
	trimmed := strings.TrimSpace(strings.ToLower(raw))
	switch trimmed {
	case "":
		return false, false, nil
	case "true", "1", "yes":
		return true, true, nil
	case "false", "0", "no":
		return false, true, nil
	default:
		return false, false, fmt.Errorf("active must be true or false")
	}
}

func monitoringOffset(raw string) (uint64, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(trimmed)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("offset must be a non-negative integer")
	}
	return uint64(value), nil
}

func monitoringSort(raw string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "", "active":
		return "active", nil
	case "recent":
		return "recent", nil
	case "oldest":
		return "oldest", nil
	default:
		return "", fmt.Errorf("sort must be active, recent, or oldest")
	}
}

func monitoringOrderBy(sortMode string) []string {
	switch sortMode {
	case "recent":
		return []string{"COALESCE(ir.finished_at, ir.started_at, ir.created_at) DESC", "ir.created_at DESC"}
	case "oldest":
		return []string{"COALESCE(ir.started_at, ir.created_at) ASC", "ir.created_at ASC"}
	default:
		return []string{
			"CASE WHEN ir.status IN ('pending', 'running') THEN 0 ELSE 1 END",
			"COALESCE(ir.started_at, ir.created_at) DESC",
			"ir.created_at DESC",
		}
	}
}

func monitoringSummary(identifier, title string) string {
	return strings.TrimSpace(strings.TrimSpace(identifier) + " " + strings.TrimSpace(title))
}

func monitoringEventTitle(eventType string) *string {
	switch strings.TrimSpace(eventType) {
	case "run.started":
		return monitoringStringPtr("Run started")
	case "agent.thinking":
		return monitoringStringPtr("Thinking")
	case "tool.called":
		return monitoringStringPtr("Tool called")
	case "comment.created":
		return monitoringStringPtr("Issue update posted")
	case "run.completed":
		return monitoringStringPtr("Run completed")
	case "run.failed":
		return monitoringStringPtr("Run failed")
	case "run.aborted":
		return monitoringStringPtr("Run aborted")
	default:
		return monitoringStringPtr("Run event")
	}
}

func monitoringCurrentStep(status string, lastEventType, lastEventSummary *string) *string {
	if lastEventType == nil {
		return nil
	}
	if status == "completed" || status == "failed" || status == "aborted" {
		return nil
	}
	if lastEventSummary != nil && strings.TrimSpace(*lastEventSummary) != "" {
		return lastEventSummary
	}
	step := strings.TrimSpace(*lastEventType)
	if step == "" {
		return nil
	}
	return monitoringStringPtr(step)
}

func monitoringEventSummary(lastEventType *string, rawPayload []byte, status string, errorMessage, resultText *string) *string {
	eventType := derefIssueString(lastEventType)
	payload := map[string]interface{}{}
	if len(rawPayload) > 0 {
		_ = json.Unmarshal(rawPayload, &payload)
	}
	switch eventType {
	case "run.started":
		mode := strings.TrimSpace(asOptionalString(payload["executionMode"]))
		if mode != "" {
			return monitoringStringPtr("Run started in " + mode + " mode")
		}
		return monitoringStringPtr("Run started")
	case "agent.thinking":
		return firstOptionalNonEmpty(optionalString(asOptionalString(payload["summary"])), monitoringStringPtr("Analyzing issue"))
	case "tool.called":
		toolName := strings.TrimSpace(asOptionalString(payload["toolName"]))
		if toolName == "" {
			return monitoringStringPtr("Calling tool")
		}
		return monitoringStringPtr("Calling " + toolName)
	case "comment.created":
		return monitoringStringPtr("Posting issue update")
	case "run.completed":
		return firstOptionalNonEmpty(trimOptionalString(resultText), monitoringStringPtr("Run completed"))
	case "run.failed":
		message := firstOptionalNonEmpty(optionalString(asOptionalString(payload["message"])), trimOptionalString(errorMessage))
		return firstOptionalNonEmpty(message, monitoringStringPtr("Run failed"))
	case "run.aborted":
		return monitoringStringPtr("Run aborted")
	default:
		switch status {
		case "completed":
			return firstOptionalNonEmpty(trimOptionalString(resultText), monitoringStringPtr("Run completed"))
		case "failed":
			return firstOptionalNonEmpty(trimOptionalString(errorMessage), monitoringStringPtr("Run failed"))
		case "aborted":
			return monitoringStringPtr("Run aborted")
		default:
			return nil
		}
	}
}

func asOptionalString(value interface{}) string {
	if raw, ok := value.(string); ok {
		return strings.TrimSpace(raw)
	}
	return ""
}

func monitoringStringPtr(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	copyValue := trimmed
	return &copyValue
}
