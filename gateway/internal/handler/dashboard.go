package handler

import (
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var dashLog = logger.Named("dashboard")

type DashboardHandler struct {
	dashboard *store.DashboardStore
}

func NewDashboardHandler(dashboard *store.DashboardStore) *DashboardHandler {
	return &DashboardHandler{dashboard: dashboard}
}

func (h *DashboardHandler) Mount(r chi.Router) {
	r.Get("/orgs/{orgId}/dashboard/stats", h.Stats)
	r.Get("/orgs/{orgId}/dashboard/message-trend", h.MessageTrend)
	r.Get("/orgs/{orgId}/dashboard/workload", h.Workload)
	r.Get("/orgs/{orgId}/dashboard/activities", h.Activities)
	r.Get("/orgs/{orgId}/dashboard/token-stats", h.TokenStats)
}

func (h *DashboardHandler) Stats(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	stats, err := h.dashboard.GetStats(r.Context(), orgID)
	if err != nil {
		dashLog.Error("get stats failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取统计失败")
		return
	}
	dashLog.Debug("get stats", zap.String("orgId", orgID))
	writeData(w, stats)
}

func (h *DashboardHandler) Workload(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	data, err := h.dashboard.GetWorkload(r.Context(), orgID)
	if err != nil {
		dashLog.Error("get workload failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取工作负载失败")
		return
	}
	if data == nil {
		data = []model.AgentWorkload{}
	}
	dashLog.Debug("get workload", zap.String("orgId", orgID))
	writeData(w, data)
}

func (h *DashboardHandler) Activities(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	data, err := h.dashboard.GetActivities(r.Context(), orgID)
	if err != nil {
		dashLog.Error("get activities failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取活动失败")
		return
	}
	if data == nil {
		data = []model.ActivityEvent{}
	}
	dashLog.Debug("get activities", zap.String("orgId", orgID))
	writeData(w, data)
}

func (h *DashboardHandler) TokenStats(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	data, err := h.dashboard.GetTokenStats(r.Context(), orgID)
	if err != nil {
		dashLog.Error("get token stats failed", zap.String("orgId", orgID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 Token 统计失败")
		return
	}
	dashLog.Debug("get token stats", zap.String("orgId", orgID))
	writeData(w, data)
}

func (h *DashboardHandler) MessageTrend(w http.ResponseWriter, r *http.Request) {
	writeData(w, []model.DailyMessageStats{})
}
