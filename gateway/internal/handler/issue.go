package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/middleware"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var issueLog = logger.Named("issue")

type IssueHandler struct {
	issues *store.IssueStore
	agents *store.AgentStore
	runs   *IssueRuntimeBridge
}

func NewIssueHandler(runtimeBaseURL string, issues *store.IssueStore, agents *store.AgentStore) *IssueHandler {
	return &IssueHandler{
		issues: issues,
		agents: agents,
		runs:   NewIssueRuntimeBridge(runtimeBaseURL, issues, agents),
	}
}

func (h *IssueHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/issues", h.List)
	r.Post("/workspaces/{wsId}/issues", h.Create)
	r.Get("/workspaces/{wsId}/issue-labels", h.ListLabels)
	r.Post("/workspaces/{wsId}/issue-labels", h.CreateLabel)
	r.Post("/workspaces/{wsId}/issues/{issueId}/attachments", h.CreateAttachment)

	r.Get("/issues/{issueId}", h.Get)
	r.Patch("/issues/{issueId}", h.Update)
	r.Delete("/issues/{issueId}", h.Delete)
	r.Get("/issues/{issueId}/ancestors", h.Ancestors)
	r.Post("/issues/{issueId}/checkout", h.Checkout)
	r.Post("/issues/{issueId}/release", h.Release)
	r.Get("/issues/{issueId}/comments", h.ListComments)
	r.Post("/issues/{issueId}/comments", h.CreateComment)
	r.Post("/issues/{issueId}/read", h.MarkRead)
	r.Get("/issues/{issueId}/attachments", h.ListAttachments)
	r.Get("/issues/{issueId}/approvals", h.ListApprovals)
	r.Post("/issues/{issueId}/approvals", h.LinkApproval)
	r.Delete("/issues/{issueId}/approvals/{approvalId}", h.UnlinkApproval)
	r.Get("/issues/{issueId}/runs", h.ListRuns)
	r.Post("/issues/{issueId}/runs", h.StartRun)
	r.Get("/issues/{issueId}/active-run", h.GetActiveRun)
	r.Get("/issues/{issueId}/events", h.ListTimeline)

	r.Delete("/issue-labels/{labelId}", h.DeleteLabel)
	r.Get("/issue-attachments/{attachmentId}/content", h.GetAttachmentContent)
	r.Delete("/issue-attachments/{attachmentId}", h.DeleteAttachment)
	r.Get("/issue-runs/{runId}/state", h.GetRunState)
	r.Get("/issue-runs/{runId}/events", h.GetRunEvents)
	r.Get("/issue-runs/{runId}/stream", h.StreamRunEvents)
	r.Post("/issue-runs/{runId}/abort", h.AbortRun)
}

func (h *IssueHandler) List(w http.ResponseWriter, r *http.Request) {
	filters := store.IssueFilters{
		Status:          strings.TrimSpace(r.URL.Query().Get("status")),
		AssigneeAgentID: strings.TrimSpace(r.URL.Query().Get("assigneeAgentId")),
		AssigneeUserID:  strings.TrimSpace(r.URL.Query().Get("assigneeUserId")),
		TouchedByUserID: strings.TrimSpace(r.URL.Query().Get("touchedByUserId")),
		UnreadForUserID: strings.TrimSpace(r.URL.Query().Get("unreadForUserId")),
		ProjectID:       strings.TrimSpace(r.URL.Query().Get("projectId")),
		ParentID:        strings.TrimSpace(r.URL.Query().Get("parentId")),
		LabelID:         strings.TrimSpace(r.URL.Query().Get("labelId")),
		Query:           strings.TrimSpace(r.URL.Query().Get("q")),
	}
	userID := middleware.GetUserID(r.Context())
	if filters.TouchedByUserID == "" && strings.EqualFold(r.URL.Query().Get("touchedByMe"), "true") {
		filters.TouchedByUserID = userID
	}
	if filters.UnreadForUserID == "" && strings.EqualFold(r.URL.Query().Get("unreadForMe"), "true") {
		filters.UnreadForUserID = userID
	}

	issues, err := h.issues.List(r.Context(), chi.URLParam(r, "wsId"), filters)
	if err != nil {
		issueLog.Error("list issues failed", zap.String("workspaceId", chi.URLParam(r, "wsId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 列表失败")
		return
	}
	if issues == nil {
		issues = []*model.Issue{}
	}
	writeData(w, issues)
}

func (h *IssueHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		ProjectID       *string  `json:"projectId"`
		GoalID          *string  `json:"goalId"`
		ParentID        *string  `json:"parentId"`
		Title           string   `json:"title"`
		Description     *string  `json:"description"`
		Status          string   `json:"status"`
		Priority        string   `json:"priority"`
		AssigneeAgentID *string  `json:"assigneeAgentId"`
		AssigneeUserID  *string  `json:"assigneeUserId"`
		RequestDepth    int      `json:"requestDepth"`
		BillingCode     *string  `json:"billingCode"`
		LabelIDs        []string `json:"labelIds"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "title is required")
		return
	}
	if assigneeAgentID := trimOptionalString(body.AssigneeAgentID); assigneeAgentID != nil {
		if err := h.validateAgentBelongsToWorkspace(r.Context(), wsID, *assigneeAgentID); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
	}
	if parentID := trimOptionalString(body.ParentID); parentID != nil {
		if err := h.validateParentIssueBelongsToWorkspace(r.Context(), wsID, *parentID, ""); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
	}
	userID := middleware.GetUserID(r.Context())
	created, err := h.issues.Create(r.Context(), store.CreateIssueInput{
		WorkspaceID:     wsID,
		ProjectID:       body.ProjectID,
		GoalID:          body.GoalID,
		ParentID:        body.ParentID,
		Title:           strings.TrimSpace(body.Title),
		Description:     trimOptionalString(body.Description),
		Status:          body.Status,
		Priority:        body.Priority,
		AssigneeAgentID: trimOptionalString(body.AssigneeAgentID),
		AssigneeUserID:  trimOptionalString(body.AssigneeUserID),
		CreatedByUserID: optionalString(userID),
		RequestDepth:    body.RequestDepth,
		BillingCode:     trimOptionalString(body.BillingCode),
		LabelIDs:        trimStringSlice(body.LabelIDs),
	})
	if err != nil {
		issueLog.Error("create issue failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Data: created})
}

func (h *IssueHandler) Get(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	writeData(w, issue)
}

func (h *IssueHandler) Update(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}

	var raw map[string]json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}

	var input store.UpdateIssueInput
	if v, ok := raw["projectId"]; ok {
		input.ProjectIDSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid projectId")
			return
		}
		input.ProjectID = value
	}
	if v, ok := raw["goalId"]; ok {
		input.GoalIDSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid goalId")
			return
		}
		input.GoalID = value
	}
	if v, ok := raw["parentId"]; ok {
		input.ParentIDSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid parentId")
			return
		}
		input.ParentID = value
	}
	if v, ok := raw["title"]; ok {
		var title string
		if err := json.Unmarshal(v, &title); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid title")
			return
		}
		trimmed := strings.TrimSpace(title)
		input.Title = &trimmed
	}
	if v, ok := raw["description"]; ok {
		input.DescriptionSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid description")
			return
		}
		input.Description = value
	}
	if v, ok := raw["status"]; ok {
		var status string
		if err := json.Unmarshal(v, &status); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid status")
			return
		}
		input.Status = &status
	}
	if v, ok := raw["priority"]; ok {
		var priority string
		if err := json.Unmarshal(v, &priority); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid priority")
			return
		}
		input.Priority = &priority
	}
	if v, ok := raw["assigneeAgentId"]; ok {
		input.AssigneeAgentSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid assigneeAgentId")
			return
		}
		input.AssigneeAgentID = value
	}
	if v, ok := raw["assigneeUserId"]; ok {
		input.AssigneeUserSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid assigneeUserId")
			return
		}
		input.AssigneeUserID = value
	}
	if v, ok := raw["billingCode"]; ok {
		input.BillingCodeSet = true
		value, err := decodeNullableString(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid billingCode")
			return
		}
		input.BillingCode = value
	}
	if v, ok := raw["hiddenAt"]; ok {
		input.HiddenAtSet = true
		value, err := decodeNullableTime(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid hiddenAt")
			return
		}
		input.HiddenAt = value
	}
	if v, ok := raw["labelIds"]; ok {
		input.LabelIDsSet = true
		var labelIDs []string
		if err := json.Unmarshal(v, &labelIDs); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid labelIds")
			return
		}
		input.LabelIDs = trimStringSlice(labelIDs)
	}
	if input.AssigneeAgentSet && input.AssigneeAgentID != nil {
		if err := h.validateAgentBelongsToWorkspace(r.Context(), issue.WorkspaceID, *input.AssigneeAgentID); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
	}
	if input.ParentIDSet && input.ParentID != nil {
		if err := h.validateParentIssueBelongsToWorkspace(r.Context(), issue.WorkspaceID, *input.ParentID, issue.ID); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
	}

	updated, err := h.issues.Update(r.Context(), issue.ID, input)
	if err != nil {
		issueLog.Error("update issue failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	writeData(w, updated)
}

func (h *IssueHandler) Delete(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	if _, err := h.issues.Remove(r.Context(), issue.ID); err != nil {
		issueLog.Error("delete issue failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除 issue 失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *IssueHandler) Ancestors(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	ancestors, err := h.issues.GetAncestors(r.Context(), issue.ID)
	if err != nil {
		issueLog.Error("list issue ancestors failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 祖先链失败")
		return
	}
	if ancestors == nil {
		ancestors = []model.IssueAncestor{}
	}
	writeData(w, ancestors)
}

func (h *IssueHandler) Checkout(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	var body struct {
		AgentID          string   `json:"agentId"`
		ExecutionMode    *string  `json:"executionMode"`
		ExecutorName     *string  `json:"executorName"`
		ExecutorHostname *string  `json:"executorHostname"`
		ExecutorPlatform *string  `json:"executorPlatform"`
		RunID            *string  `json:"runId"`
		ExpectedStatuses []string `json:"expectedStatuses"`
		TriggerSource    string   `json:"triggerSource"`
		TriggerDetail    *string  `json:"triggerDetail"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.AgentID) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "agentId is required")
		return
	}
	if err := h.validateAgentBelongsToIssueWorkspace(r.Context(), issue, strings.TrimSpace(body.AgentID)); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	executionMode, executionModeSet, err := normalizeExecutionMode(body.ExecutionMode)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}

	runID := strings.TrimSpace(derefIssueString(body.RunID))
	if runID == "" {
		runID = uuid.NewString()
	}
	userID := middleware.GetUserID(r.Context())
	run, err := h.runs.EnsureRun(
		r.Context(),
		issue,
		strings.TrimSpace(body.AgentID),
		executionMode,
		executionModeSet,
		trimOptionalString(body.ExecutorName),
		trimOptionalString(body.ExecutorHostname),
		trimOptionalString(body.ExecutorPlatform),
		runID,
		firstNonEmpty(body.TriggerSource, "checkout"),
		trimOptionalString(body.TriggerDetail),
		optionalString(userID),
	)
	if err != nil {
		issueLog.Error("ensure checkout issue run failed", zap.String("issueId", issue.ID), zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建 issue 执行记录失败")
		return
	}
	checkedOut, err := h.issues.Checkout(r.Context(), issue.ID, strings.TrimSpace(body.AgentID), trimStringSlice(body.ExpectedStatuses), runID)
	if err != nil {
		h.failRunRecord(r.Context(), run.ID, "checkout conflict")
		if err == store.ErrIssueCheckoutConflict {
			writeError(w, http.StatusConflict, "CHECKOUT_CONFLICT", "issue 已被其他执行占用")
			return
		}
		issueLog.Error("checkout issue failed", zap.String("issueId", issue.ID), zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "checkout issue 失败")
		return
	}
	if err := h.runs.SyncExecutionLock(r.Context(), checkedOut.ID, run.AgentID); err != nil {
		issueLog.Error("set issue execution lock failed", zap.String("issueId", checkedOut.ID), zap.String("runId", run.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "设置 issue 执行锁失败")
		return
	}
	writeData(w, map[string]interface{}{"issue": checkedOut, "run": run})
}

func (h *IssueHandler) Release(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	var body struct {
		RunID string `json:"runId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.RunID) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "runId is required")
		return
	}
	released, err := h.issues.Release(r.Context(), issue.ID, strings.TrimSpace(body.RunID))
	if err != nil {
		if err == store.ErrIssueReleaseConflict {
			writeError(w, http.StatusConflict, "RELEASE_CONFLICT", "只有 checkout 所有者可以 release issue")
			return
		}
		issueLog.Error("release issue failed", zap.String("issueId", issue.ID), zap.String("runId", body.RunID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "release issue 失败")
		return
	}
	go h.runs.AbortBestEffort(strings.TrimSpace(body.RunID), r.Header.Get("Authorization"))
	if run, err := h.issues.GetRunByID(r.Context(), strings.TrimSpace(body.RunID)); err == nil && run != nil && !isTerminalIssueRunStatus(run.Status) {
		now := time.Now().UTC()
		aborted := "aborted"
		_, _ = h.issues.UpdateRun(r.Context(), run.ID, store.UpdateIssueRunInput{
			Status:        &aborted,
			FinishedAt:    &now,
			FinishedAtSet: true,
		})
	}
	writeData(w, released)
}

func (h *IssueHandler) ListComments(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	comments, err := h.issues.ListComments(r.Context(), issue.ID)
	if err != nil {
		issueLog.Error("list issue comments failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 评论失败")
		return
	}
	if comments == nil {
		comments = []model.IssueComment{}
	}
	writeData(w, comments)
}

func (h *IssueHandler) CreateComment(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	var body struct {
		Body    string               `json:"body"`
		Actions []issueCommentAction `json:"actions"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "body is required")
		return
	}
	if err := h.validateCommentActions(r.Context(), issue, body.Actions); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	comment, err := h.issues.AddComment(r.Context(), store.CreateIssueCommentInput{
		WorkspaceID:  issue.WorkspaceID,
		IssueID:      issue.ID,
		AuthorUserID: optionalString(middleware.GetUserID(r.Context())),
		Body:         strings.TrimSpace(body.Body),
	})
	if err != nil {
		issueLog.Error("create issue comment failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建 issue 评论失败")
		return
	}
	updatedIssue := issue
	actionResults := []issueCommentActionResult{}
	if len(body.Actions) > 0 {
		actionResults, updatedIssue = h.executeCommentActions(r.Context(), issue, strings.TrimSpace(body.Body), body.Actions, middleware.GetUserID(r.Context()), r.Header.Get("Authorization"))
	}
	writeJSON(w, http.StatusCreated, apiResponse{Data: map[string]interface{}{"comment": comment, "issue": updatedIssue, "actions": actionResults}})
}

func (h *IssueHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	var body struct {
		ReadAt *string `json:"readAt"`
	}
	if err := decodeBody(r, &body); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	readAt := time.Now().UTC()
	if body.ReadAt != nil && strings.TrimSpace(*body.ReadAt) != "" {
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(*body.ReadAt))
		if err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid readAt")
			return
		}
		readAt = parsed.UTC()
	}
	state, err := h.issues.MarkRead(r.Context(), issue.WorkspaceID, issue.ID, middleware.GetUserID(r.Context()), readAt)
	if err != nil {
		issueLog.Error("mark issue read failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "标记 issue 已读失败")
		return
	}
	writeData(w, state)
}

func (h *IssueHandler) ListLabels(w http.ResponseWriter, r *http.Request) {
	labels, err := h.issues.ListLabels(r.Context(), chi.URLParam(r, "wsId"))
	if err != nil {
		issueLog.Error("list issue labels failed", zap.String("workspaceId", chi.URLParam(r, "wsId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 标签失败")
		return
	}
	if labels == nil {
		labels = []model.IssueLabel{}
	}
	writeData(w, labels)
}

func (h *IssueHandler) CreateLabel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}
	if strings.TrimSpace(body.Color) == "" {
		body.Color = "#6B7280"
	}
	label, err := h.issues.CreateLabel(r.Context(), store.CreateIssueLabelInput{
		WorkspaceID: chi.URLParam(r, "wsId"),
		Name:        strings.TrimSpace(body.Name),
		Color:       strings.TrimSpace(body.Color),
	})
	if err != nil {
		issueLog.Error("create issue label failed", zap.String("workspaceId", chi.URLParam(r, "wsId")), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Data: label})
}

func (h *IssueHandler) DeleteLabel(w http.ResponseWriter, r *http.Request) {
	label, err := h.issues.DeleteLabel(r.Context(), chi.URLParam(r, "labelId"))
	if err != nil {
		issueLog.Error("delete issue label failed", zap.String("labelId", chi.URLParam(r, "labelId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除 issue 标签失败")
		return
	}
	if label == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 标签不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *IssueHandler) ListAttachments(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	attachments, err := h.issues.ListAttachments(r.Context(), issue.ID)
	if err != nil {
		issueLog.Error("list issue attachments failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 附件失败")
		return
	}
	for i := range attachments {
		attachments[i].ContentPath = "/api/issue-attachments/" + attachments[i].ID + "/content"
	}
	if attachments == nil {
		attachments = []model.IssueAttachment{}
	}
	writeData(w, attachments)
}

func (h *IssueHandler) CreateAttachment(w http.ResponseWriter, r *http.Request) {
	issueID, err := h.issues.ResolveID(r.Context(), chi.URLParam(r, "issueId"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "解析 issue 失败")
		return
	}
	issue, err := h.issues.GetByID(r.Context(), issueID)
	if err != nil {
		issueLog.Error("get issue for attachment failed", zap.String("issueId", issueID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 issue 失败")
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "file is required")
		return
	}
	defer file.Close()
	content, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "读取附件失败")
		return
	}
	var issueCommentID *string
	if raw := strings.TrimSpace(r.FormValue("issueCommentId")); raw != "" {
		issueCommentID = &raw
	}
	attachment, err := h.issues.CreateAttachment(r.Context(), store.CreateIssueAttachmentInput{
		WorkspaceID:      issue.WorkspaceID,
		IssueID:          issue.ID,
		IssueCommentID:   issueCommentID,
		ContentType:      firstNonEmpty(header.Header.Get("Content-Type"), "application/octet-stream"),
		OriginalFilename: optionalString(header.Filename),
		CreatedByUserID:  optionalString(middleware.GetUserID(r.Context())),
		Content:          content,
	})
	if err != nil {
		issueLog.Error("create issue attachment failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "上传 issue 附件失败")
		return
	}
	attachment.ContentPath = "/api/issue-attachments/" + attachment.ID + "/content"
	writeJSON(w, http.StatusCreated, apiResponse{Data: attachment})
}

func (h *IssueHandler) GetAttachmentContent(w http.ResponseWriter, r *http.Request) {
	attachment, content, err := h.issues.GetAttachmentByID(r.Context(), chi.URLParam(r, "attachmentId"))
	if err != nil {
		issueLog.Error("get issue attachment content failed", zap.String("attachmentId", chi.URLParam(r, "attachmentId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 附件失败")
		return
	}
	if attachment == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 附件不存在")
		return
	}
	if strings.TrimSpace(attachment.ContentType) != "" {
		w.Header().Set("Content-Type", attachment.ContentType)
	}
	w.Header().Set("Content-Length", strconv.FormatInt(attachment.ByteSize, 10))
	if attachment.OriginalFilename != nil && strings.TrimSpace(*attachment.OriginalFilename) != "" {
		w.Header().Set("Content-Disposition", "inline; filename="+strconv.Quote(strings.TrimSpace(*attachment.OriginalFilename)))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (h *IssueHandler) DeleteAttachment(w http.ResponseWriter, r *http.Request) {
	attachment, err := h.issues.RemoveAttachment(r.Context(), chi.URLParam(r, "attachmentId"))
	if err != nil {
		issueLog.Error("delete issue attachment failed", zap.String("attachmentId", chi.URLParam(r, "attachmentId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除 issue 附件失败")
		return
	}
	if attachment == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 附件不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *IssueHandler) ListApprovals(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	approvals, err := h.issues.ListApprovals(r.Context(), issue.ID)
	if err != nil {
		issueLog.Error("list issue approvals failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue approvals 失败")
		return
	}
	if approvals == nil {
		approvals = []model.IssueApproval{}
	}
	writeData(w, approvals)
}

func (h *IssueHandler) LinkApproval(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	var body struct {
		ApprovalID string `json:"approvalId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.ApprovalID) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "approvalId is required")
		return
	}
	if err := h.validateApprovalBelongsToIssueWorkspace(r.Context(), issue, strings.TrimSpace(body.ApprovalID)); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if err := h.issues.LinkApproval(r.Context(), issue.WorkspaceID, issue.ID, strings.TrimSpace(body.ApprovalID), optionalString(middleware.GetUserID(r.Context()))); err != nil {
		issueLog.Error("link issue approval failed", zap.String("issueId", issue.ID), zap.String("approvalId", body.ApprovalID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "关联 issue approval 失败")
		return
	}
	_ = h.issues.AddActivityEvent(r.Context(), issue.WorkspaceID, "issue", issue.ID, "issue.approval_linked", "user", optionalString(middleware.GetUserID(r.Context())), "Approval linked", strings.TrimSpace(body.ApprovalID), map[string]interface{}{"approvalId": strings.TrimSpace(body.ApprovalID)})
	w.WriteHeader(http.StatusNoContent)
}

func (h *IssueHandler) UnlinkApproval(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	if err := h.issues.UnlinkApproval(r.Context(), issue.ID, chi.URLParam(r, "approvalId")); err != nil {
		issueLog.Error("unlink issue approval failed", zap.String("issueId", issue.ID), zap.String("approvalId", chi.URLParam(r, "approvalId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "解除 issue approval 关联失败")
		return
	}
	_ = h.issues.AddActivityEvent(r.Context(), issue.WorkspaceID, "issue", issue.ID, "issue.approval_unlinked", "user", optionalString(middleware.GetUserID(r.Context())), "Approval unlinked", chi.URLParam(r, "approvalId"), map[string]interface{}{"approvalId": chi.URLParam(r, "approvalId")})
	w.WriteHeader(http.StatusNoContent)
}

func (h *IssueHandler) ListRuns(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid limit")
			return
		}
		limit = parsed
	}
	runs, err := h.issues.ListRunsByIssue(r.Context(), issue.ID, limit)
	if err != nil {
		issueLog.Error("list issue runs failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue runs 失败")
		return
	}
	if runs == nil {
		runs = []model.IssueRun{}
	}
	writeData(w, runs)
}

func (h *IssueHandler) StartRun(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	var body struct {
		AgentID          string   `json:"agentId"`
		ExecutionMode    *string  `json:"executionMode"`
		ExecutorName     *string  `json:"executorName"`
		ExecutorHostname *string  `json:"executorHostname"`
		ExecutorPlatform *string  `json:"executorPlatform"`
		RunID            *string  `json:"runId"`
		ExpectedStatuses []string `json:"expectedStatuses"`
		TriggerSource    string   `json:"triggerSource"`
		TriggerDetail    *string  `json:"triggerDetail"`
		Goal             *string  `json:"goal"`
		Title            *string  `json:"title"`
		UserMessage      *string  `json:"userMessage"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.AgentID) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "agentId is required")
		return
	}
	if err := h.validateAgentBelongsToIssueWorkspace(r.Context(), issue, strings.TrimSpace(body.AgentID)); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	executionMode, executionModeSet, err := normalizeExecutionMode(body.ExecutionMode)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	issueRun, updatedIssue, err := h.runs.Start(r.Context(), issue, IssueRunStartRequest{
		AgentID:           strings.TrimSpace(body.AgentID),
		ExecutionMode:     executionMode,
		ExecutionModeSet:  executionModeSet,
		ExecutorName:      trimOptionalString(body.ExecutorName),
		ExecutorHostname:  trimOptionalString(body.ExecutorHostname),
		ExecutorPlatform:  trimOptionalString(body.ExecutorPlatform),
		RunID:             strings.TrimSpace(derefIssueString(body.RunID)),
		ExpectedStatuses:  trimStringSlice(body.ExpectedStatuses),
		TriggerSource:     firstNonEmpty(body.TriggerSource, "manual"),
		TriggerDetail:     trimOptionalString(body.TriggerDetail),
		Goal:              trimOptionalString(body.Goal),
		Title:             firstOptionalNonEmpty(trimOptionalString(body.Title), &issue.Title),
		UserMessage:       firstOptionalNonEmpty(trimOptionalString(body.UserMessage), issue.Description),
		RequestedByUserID: optionalString(middleware.GetUserID(r.Context())),
		Authorization:     r.Header.Get("Authorization"),
	})
	if err != nil {
		status := http.StatusInternalServerError
		code := "INTERNAL_ERROR"
		if strings.Contains(err.Error(), "bad request") {
			status = http.StatusBadRequest
			code = "BAD_REQUEST"
		} else if err == store.ErrIssueCheckoutConflict {
			status = http.StatusConflict
			code = "CHECKOUT_CONFLICT"
		}
		issueLog.Error("start issue run failed", zap.String("issueId", issue.ID), zap.String("agentId", body.AgentID), zap.Error(err))
		writeError(w, status, code, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Data: map[string]interface{}{"issue": updatedIssue, "run": issueRun}})
}

func (h *IssueHandler) GetActiveRun(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	_ = h.runs.ReconcileStaleRuns(r.Context(), issue.WorkspaceID)
	run, err := h.issues.GetActiveRunByIssue(r.Context(), issue.ID)
	if err != nil {
		issueLog.Error("get active issue run failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取活跃 issue run 失败")
		return
	}
	if run == nil {
		writeData(w, map[string]interface{}{})
		return
	}
	writeData(w, run)
}

func (h *IssueHandler) ListTimeline(w http.ResponseWriter, r *http.Request) {
	issue, err := h.getIssueFromRoute(r)
	if err != nil {
		h.writeIssueLookupError(w, err)
		return
	}
	if issue == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue 不存在")
		return
	}
	events, err := h.timeline(r.Context(), issue.ID)
	if err != nil {
		issueLog.Error("list issue timeline failed", zap.String("issueId", issue.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue 时间线失败")
		return
	}
	writeData(w, events)
}

func (h *IssueHandler) GetRunState(w http.ResponseWriter, r *http.Request) {
	if run, err := h.issues.GetRunByID(r.Context(), chi.URLParam(r, "runId")); err == nil && run != nil {
		_ = h.runs.ReconcileStaleRuns(r.Context(), run.WorkspaceID)
	}
	state, err := h.runs.GetState(r.Context(), chi.URLParam(r, "runId"), r.Header.Get("Authorization"))
	if err != nil {
		if err == errIssueRuntimeRunNotFound {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "issue run 不存在")
			return
		}
		issueLog.Error("get issue run state failed", zap.String("runId", chi.URLParam(r, "runId")), zap.Error(err))
		writeError(w, http.StatusBadGateway, "RUNTIME_UNAVAILABLE", "issue runtime 不可用")
		return
	}
	writeData(w, state)
}

func (h *IssueHandler) GetRunEvents(w http.ResponseWriter, r *http.Request) {
	events, err := h.issues.ListRunEvents(r.Context(), chi.URLParam(r, "runId"))
	if err != nil {
		issueLog.Error("get issue run events failed", zap.String("runId", chi.URLParam(r, "runId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 issue run events 失败")
		return
	}
	if events == nil {
		events = []model.IssueRunEvent{}
	}
	run, _ := h.issues.GetRunByID(r.Context(), chi.URLParam(r, "runId"))
	if run == nil && len(events) == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue run 不存在")
		return
	}
	writeData(w, hydrateIssueRunEvents(events, run))
}

func (h *IssueHandler) AbortRun(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	if strings.TrimSpace(runID) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "runId is required")
		return
	}
	if run, err := h.issues.GetRunByID(r.Context(), runID); err == nil && run != nil {
		_ = h.runs.ReconcileStaleRuns(r.Context(), run.WorkspaceID)
	}
	if err := h.runs.Abort(r.Context(), runID, r.Header.Get("Authorization")); err != nil {
		if err == errIssueRuntimeRunNotFound {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "issue run 不存在")
			return
		}
		issueLog.Error("abort issue run failed", zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusBadGateway, "RUNTIME_UNAVAILABLE", "终止 issue run 失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *IssueHandler) getIssueFromRoute(r *http.Request) (*model.Issue, error) {
	id, err := h.issues.ResolveID(r.Context(), chi.URLParam(r, "issueId"))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(id) == "" {
		return nil, nil
	}
	return h.issues.GetByID(r.Context(), id)
}

func (h *IssueHandler) writeIssueLookupError(w http.ResponseWriter, err error) {
	issueLog.Error("resolve issue failed", zap.Error(err))
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 issue 失败")
}

func (h *IssueHandler) timeline(ctx context.Context, issueID string) ([]model.IssueTimelineEvent, error) {
	activityEvents, err := h.issues.ListTimelineEvents(ctx, issueID)
	if err != nil {
		return nil, err
	}
	comments, err := h.issues.ListComments(ctx, issueID)
	if err != nil {
		return nil, err
	}
	events := make([]model.IssueTimelineEvent, 0, len(activityEvents)+len(comments))
	events = append(events, activityEvents...)
	for _, comment := range comments {
		events = append(events, model.IssueTimelineEvent{
			ID:          "comment:" + comment.ID,
			Type:        "issue.comment_added",
			EntityType:  "issue_comment",
			EntityID:    comment.ID,
			Title:       "Issue comment",
			Description: comment.Body,
			CreatedAt:   comment.CreatedAt,
			Metadata: map[string]interface{}{
				"authorAgentId": comment.AuthorAgentID,
				"authorUserId":  comment.AuthorUserID,
			},
		})
	}
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].CreatedAt.Equal(events[j].CreatedAt) {
			return events[i].ID < events[j].ID
		}
		return events[i].CreatedAt.Before(events[j].CreatedAt)
	})
	return events, nil
}

func issueRunTimelineTitle(run model.IssueRun) string {
	switch strings.TrimSpace(run.Status) {
	case "pending":
		return "Run queued"
	case "running":
		return "Run started"
	case "completed":
		return "Run completed"
	case "failed":
		return "Run failed"
	case "aborted":
		return "Run aborted"
	default:
		return "Run updated"
	}
}

func issueRunTimelineDescription(run model.IssueRun, agentName string) string {
	actor := firstNonEmpty(strings.TrimSpace(agentName), strings.TrimSpace(run.AgentID), "Agent")
	executionContext := issueRunExecutionContext(run)
	triggerDetail := derefIssueString(run.TriggerDetail)
	switch strings.TrimSpace(run.Status) {
	case "pending":
		if triggerDetail != "" {
			return fmt.Sprintf("%s queued a %s run. %s", actor, executionContext, triggerDetail)
		}
		return fmt.Sprintf("%s queued a %s run.", actor, executionContext)
	case "running":
		if triggerDetail != "" {
			return fmt.Sprintf("%s started working %s. %s", actor, executionContext, triggerDetail)
		}
		return fmt.Sprintf("%s started working %s.", actor, executionContext)
	case "completed":
		if result := derefIssueString(run.ResultText); result != "" {
			return result
		}
		return fmt.Sprintf("%s completed the run %s.", actor, executionContext)
	case "failed":
		if message := derefIssueString(run.ErrorMessage); message != "" {
			return message
		}
		return fmt.Sprintf("%s failed the run %s.", actor, executionContext)
	case "aborted":
		return fmt.Sprintf("%s stopped the run %s.", actor, executionContext)
	default:
		return firstNonEmpty(derefIssueString(run.ResultText), derefIssueString(run.ErrorMessage), triggerDetail, run.TriggerSource)
	}
}

func issueRunTimelineAt(run model.IssueRun) time.Time {
	switch strings.TrimSpace(run.Status) {
	case "completed", "failed", "aborted":
		if run.FinishedAt != nil {
			return run.FinishedAt.UTC()
		}
	}
	if run.StartedAt != nil {
		return run.StartedAt.UTC()
	}
	return run.CreatedAt.UTC()
}

func issueRunExecutionContext(run model.IssueRun) string {
	mode := firstNonEmpty(run.ExecutionMode, "cloud")
	label := ""
	switch mode {
	case "local":
		label = "locally"
	default:
		label = "in cloud"
	}
	targetName := firstNonEmpty(derefIssueString(run.ExecutorName), derefIssueString(run.ExecutorHostname))
	platform := derefIssueString(run.ExecutorPlatform)
	if targetName != "" && platform != "" {
		return fmt.Sprintf("%s on %s (%s)", label, targetName, platform)
	}
	if targetName != "" {
		return fmt.Sprintf("%s on %s", label, targetName)
	}
	if platform != "" {
		return fmt.Sprintf("%s on %s", label, platform)
	}
	return label
}

func (h *IssueHandler) failRunRecord(ctx context.Context, runID, message string) {
	if strings.TrimSpace(runID) == "" {
		return
	}
	now := time.Now().UTC()
	failed := "failed"
	trimmedMessage := strings.TrimSpace(message)
	_, _ = h.issues.UpdateRun(ctx, runID, store.UpdateIssueRunInput{
		Status:          &failed,
		FinishedAt:      &now,
		FinishedAtSet:   true,
		ErrorMessage:    &trimmedMessage,
		ErrorMessageSet: true,
	})
}

func (h *IssueHandler) validateParentIssueBelongsToWorkspace(ctx context.Context, workspaceID, parentID, currentIssueID string) error {
	resolvedID, err := h.issues.ResolveID(ctx, parentID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(resolvedID) == "" {
		return nil
	}
	if currentIssueID != "" && resolvedID == currentIssueID {
		return fmt.Errorf("issue cannot be its own parent")
	}
	parent, err := h.issues.GetByID(ctx, resolvedID)
	if err != nil {
		return err
	}
	if parent == nil {
		return fmt.Errorf("parent issue not found")
	}
	if parent.WorkspaceID != workspaceID {
		return fmt.Errorf("parent issue does not belong to the issue workspace")
	}
	return nil
}

func decodeNullableString(raw json.RawMessage) (*string, error) {
	if string(raw) == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return trimOptionalString(&value), nil
}

func decodeNullableTime(raw json.RawMessage) (*time.Time, error) {
	if string(raw) == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return nil, err
	}
	parsed = parsed.UTC()
	return &parsed, nil
}

func trimOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	copyValue := trimmed
	return &copyValue
}

func normalizeExecutionMode(value *string) (string, bool, error) {
	if value == nil {
		return "cloud", false, nil
	}
	trimmed := strings.ToLower(strings.TrimSpace(*value))
	switch trimmed {
	case "":
		return "cloud", false, nil
	case "cloud", "local":
		return trimmed, true, nil
	default:
		return "", false, fmt.Errorf("executionMode must be cloud or local")
	}
}

func optionalString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	copyValue := trimmed
	return &copyValue
}

func trimStringSlice(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func derefIssueString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstOptionalNonEmpty(values ...*string) *string {
	for _, value := range values {
		if trimmed := trimOptionalString(value); trimmed != nil {
			return trimmed
		}
	}
	return nil
}

func isTerminalIssueRunStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "completed", "failed", "aborted":
		return true
	default:
		return false
	}
}

func marshalJSONBody(payload interface{}) io.Reader {
	body, _ := json.Marshal(payload)
	return bytes.NewReader(body)
}

func issueErrorf(message string, err error) error {
	if err == nil {
		return fmt.Errorf(message)
	}
	return fmt.Errorf("%s: %w", message, err)
}
