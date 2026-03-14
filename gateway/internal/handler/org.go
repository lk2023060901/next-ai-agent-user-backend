package handler

import (
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/middleware"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var orgLog = logger.Named("org")

type OrgHandler struct {
	orgs *store.OrgStore
}

func NewOrgHandler(orgs *store.OrgStore) *OrgHandler {
	return &OrgHandler{orgs: orgs}
}

func (h *OrgHandler) Mount(r chi.Router) {
	r.Get("/orgs", h.List)
	r.Get("/orgs/{orgId}", h.Get)
	r.Patch("/orgs/{orgId}", h.Update)
	r.Get("/orgs/{orgId}/members", h.Members)
	r.Get("/orgs/{orgId}/workspaces", h.Workspaces)
}

func (h *OrgHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	orgs, err := h.orgs.ListByUser(r.Context(), userID)
	if err != nil {
		orgLog.Error("list orgs failed", zap.String("userId", userID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取组织列表失败")
		return
	}
	if orgs == nil {
		orgs = []model.Org{}
	}
	orgLog.Debug("list orgs", zap.String("userId", userID), zap.Int("count", len(orgs)))
	writeData(w, orgs)
}

func (h *OrgHandler) Get(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	org, err := h.orgs.GetByID(r.Context(), orgID)
	if err != nil {
		orgLog.Error("get org failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取组织失败")
		return
	}
	if org == nil {
		orgLog.Debug("org not found", zap.String("orgId", orgID))
		writeError(w, http.StatusNotFound, "NOT_FOUND", "组织不存在")
		return
	}
	orgLog.Debug("get org", zap.String("orgId", orgID))
	writeData(w, org)
}

func (h *OrgHandler) Update(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		orgLog.Warn("update org: invalid body", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	dbFields := make(map[string]interface{})
	if v, ok := body["name"]; ok {
		dbFields["name"] = v
	}
	if len(dbFields) == 0 {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "no fields to update")
		return
	}
	org, err := h.orgs.Update(r.Context(), orgID, dbFields)
	if err != nil {
		orgLog.Error("update org failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新组织失败")
		return
	}
	orgLog.Debug("update org", zap.String("orgId", orgID))
	writeData(w, org)
}

func (h *OrgHandler) Members(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	members, err := h.orgs.ListMembers(r.Context(), orgID)
	if err != nil {
		orgLog.Error("list members failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取成员列表失败")
		return
	}
	if members == nil {
		members = []model.OrgMember{}
	}
	orgLog.Debug("list members", zap.String("orgId", orgID), zap.Int("count", len(members)))
	writeData(w, members)
}

func (h *OrgHandler) Workspaces(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	wss, err := h.orgs.ListWorkspaces(r.Context(), orgID)
	if err != nil {
		orgLog.Error("list workspaces failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取工作区列表失败")
		return
	}
	if wss == nil {
		wss = []model.Workspace{}
	}
	orgLog.Debug("list workspaces", zap.String("orgId", orgID), zap.Int("count", len(wss)))
	writeData(w, wss)
}
