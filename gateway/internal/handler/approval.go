package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/middleware"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var approvalLog = logger.Named("approval")

type ApprovalHandler struct {
	issues *store.IssueStore
}

func NewApprovalHandler(issues *store.IssueStore) *ApprovalHandler {
	return &ApprovalHandler{issues: issues}
}

func (h *ApprovalHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/approvals", h.List)
	r.Post("/workspaces/{wsId}/approvals", h.Create)
	r.Get("/approvals/{approvalId}", h.Get)
	r.Patch("/approvals/{approvalId}", h.Update)
	r.Get("/approvals/{approvalId}/events", h.ListEvents)
}

func (h *ApprovalHandler) List(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid limit")
			return
		}
		limit = parsed
	}
	items, err := h.issues.ListApprovalsByWorkspace(r.Context(), chi.URLParam(r, "wsId"), strings.TrimSpace(r.URL.Query().Get("status")), limit)
	if err != nil {
		approvalLog.Error("list approvals failed", zap.String("workspaceId", chi.URLParam(r, "wsId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 approvals 失败")
		return
	}
	if items == nil {
		items = []model.Approval{}
	}
	writeData(w, items)
}

func (h *ApprovalHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IssueID      *string `json:"issueId"`
		Title        string  `json:"title"`
		Description  *string `json:"description"`
		DecisionNote *string `json:"decisionNote"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "title is required")
		return
	}
	workspaceID := chi.URLParam(r, "wsId")
	var linkedIssue *model.Issue
	if issueID := trimOptionalString(body.IssueID); issueID != nil {
		resolvedID, err := h.issues.ResolveID(r.Context(), *issueID)
		if err != nil {
			approvalLog.Error("resolve approval issue failed", zap.String("workspaceId", workspaceID), zap.String("issueId", *issueID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "解析 issue 失败")
			return
		}
		linkedIssue, err = h.issues.GetByID(r.Context(), resolvedID)
		if err != nil {
			approvalLog.Error("load approval issue failed", zap.String("workspaceId", workspaceID), zap.String("issueId", resolvedID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 issue 失败")
			return
		}
		if linkedIssue == nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "issue not found")
			return
		}
		if linkedIssue.WorkspaceID != workspaceID {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "issue does not belong to the approval workspace")
			return
		}
	}
	approval, err := h.issues.CreateApproval(r.Context(), store.CreateApprovalInput{
		WorkspaceID:       workspaceID,
		Title:             strings.TrimSpace(body.Title),
		Description:       trimOptionalString(body.Description),
		RequestedByUserID: optionalString(middleware.GetUserID(r.Context())),
	})
	if err != nil {
		approvalLog.Error("create approval failed", zap.String("workspaceId", workspaceID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建 approval 失败")
		return
	}
	_, _ = h.issues.AddApprovalEvent(r.Context(), store.CreateApprovalEventInput{
		ApprovalID:  approval.ID,
		WorkspaceID: approval.WorkspaceID,
		Action:      "approval.requested",
		ActorType:   "user",
		ActorID:     optionalString(middleware.GetUserID(r.Context())),
		Note:        trimOptionalString(body.DecisionNote),
		Metadata:    map[string]interface{}{"status": approval.Status},
	})
	if linkedIssue != nil {
		if err := h.issues.LinkApproval(r.Context(), workspaceID, linkedIssue.ID, approval.ID, optionalString(middleware.GetUserID(r.Context()))); err != nil {
			approvalLog.Error("link approval to issue failed", zap.String("workspaceId", workspaceID), zap.String("issueId", linkedIssue.ID), zap.String("approvalId", approval.ID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "关联 approval 到 issue 失败")
			return
		}
		_ = h.issues.AddActivityEvent(r.Context(), workspaceID, "issue", linkedIssue.ID, "issue.approval_requested", "user", optionalString(middleware.GetUserID(r.Context())), "Approval requested", approval.Title, map[string]interface{}{"approvalId": approval.ID, "status": approval.Status})
	}
	writeJSON(w, http.StatusCreated, apiResponse{Data: approval})
}

func (h *ApprovalHandler) Get(w http.ResponseWriter, r *http.Request) {
	approval, err := h.issues.GetApprovalByID(r.Context(), chi.URLParam(r, "approvalId"))
	if err != nil {
		approvalLog.Error("get approval failed", zap.String("approvalId", chi.URLParam(r, "approvalId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 approval 失败")
		return
	}
	if approval == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "approval 不存在")
		return
	}
	writeData(w, approval)
}

func (h *ApprovalHandler) Update(w http.ResponseWriter, r *http.Request) {
	approval, err := h.issues.GetApprovalByID(r.Context(), chi.URLParam(r, "approvalId"))
	if err != nil {
		approvalLog.Error("load approval failed", zap.String("approvalId", chi.URLParam(r, "approvalId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 approval 失败")
		return
	}
	if approval == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "approval 不存在")
		return
	}
	var body struct {
		Status       *string `json:"status"`
		DecisionNote *string `json:"decisionNote"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	input := store.UpdateApprovalInput{}
	action := "approval.updated"
	if body.Status != nil {
		status, statusErr := approvalStatusValue(*body.Status)
		if statusErr != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", statusErr.Error())
			return
		}
		input.Status = &status
		if status != "pending" {
			now := time.Now().UTC()
			input.ResolvedAt = &now
			input.ResolvedAtSet = true
			input.ResolvedByUserID = optionalString(middleware.GetUserID(r.Context()))
			input.ResolvedByUserSet = true
			action = "approval." + status
		} else {
			input.ResolvedAt = nil
			input.ResolvedAtSet = true
			input.ResolvedByUserID = nil
			input.ResolvedByUserSet = true
		}
	}
	if body.DecisionNote != nil {
		input.DecisionNote = trimOptionalString(body.DecisionNote)
		input.DecisionNoteSet = true
	}
	updated, err := h.issues.UpdateApproval(r.Context(), approval.ID, input)
	if err != nil {
		approvalLog.Error("update approval failed", zap.String("approvalId", approval.ID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新 approval 失败")
		return
	}
	if updated == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "approval 不存在")
		return
	}
	_, _ = h.issues.AddApprovalEvent(r.Context(), store.CreateApprovalEventInput{
		ApprovalID:  updated.ID,
		WorkspaceID: updated.WorkspaceID,
		Action:      action,
		ActorType:   "user",
		ActorID:     optionalString(middleware.GetUserID(r.Context())),
		Note:        trimOptionalString(body.DecisionNote),
		Metadata:    map[string]interface{}{"status": updated.Status},
	})
	linkedIssueIDs, _ := h.issues.ListLinkedIssueIDsByApproval(r.Context(), updated.ID)
	for _, issueID := range linkedIssueIDs {
		_ = h.issues.AddActivityEvent(r.Context(), updated.WorkspaceID, "issue", issueID, "issue."+action, "user", optionalString(middleware.GetUserID(r.Context())), approvalActivityTitle(updated.Status), updated.Title, map[string]interface{}{"approvalId": updated.ID, "status": updated.Status})
	}
	writeData(w, updated)
}

func (h *ApprovalHandler) ListEvents(w http.ResponseWriter, r *http.Request) {
	events, err := h.issues.ListApprovalEvents(r.Context(), chi.URLParam(r, "approvalId"))
	if err != nil {
		approvalLog.Error("list approval events failed", zap.String("approvalId", chi.URLParam(r, "approvalId")), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 approval history 失败")
		return
	}
	if events == nil {
		events = []model.ApprovalEvent{}
	}
	writeData(w, events)
}

func approvalActivityTitle(status string) string {
	switch strings.TrimSpace(status) {
	case "approved":
		return "Approval approved"
	case "rejected":
		return "Approval rejected"
	case "cancelled":
		return "Approval cancelled"
	default:
		return "Approval updated"
	}
}

func approvalStatusValue(status string) (string, error) {
	switch strings.TrimSpace(status) {
	case "approved", "rejected", "cancelled", "pending":
		return strings.TrimSpace(status), nil
	default:
		return "", fmt.Errorf("status must be pending, approved, rejected, or cancelled")
	}
}
