package handler

import (
	"net/http"
	"strings"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/store"
)

var topologyLog = logger.Named("topology")

type TopologyHandler struct {
	topology *store.TopologyStore
}

func NewTopologyHandler(topology *store.TopologyStore) *TopologyHandler {
	return &TopologyHandler{topology: topology}
}

func (h *TopologyHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/topology", h.Get)
	r.Post("/workspaces/{wsId}/topology/connections", h.AddConnection)
	r.Delete("/workspaces/{wsId}/topology/connections/{connectionId}", h.DeleteConnection)
}

func (h *TopologyHandler) Get(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	topology, err := h.topology.Get(r.Context(), wsID)
	if err != nil {
		topologyLog.Error("get topology failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取拓扑失败")
		return
	}
	writeData(w, topology)
}

func (h *TopologyHandler) AddConnection(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		SourceAgentID string  `json:"sourceAgentId"`
		TargetAgentID string  `json:"targetAgentId"`
		Label         *string `json:"label"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.SourceAgentID) == "" || strings.TrimSpace(body.TargetAgentID) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "sourceAgentId and targetAgentId are required")
		return
	}

	connection, err := h.topology.AddConnection(
		r.Context(),
		wsID,
		strings.TrimSpace(body.SourceAgentID),
		strings.TrimSpace(body.TargetAgentID),
		body.Label,
	)
	if err != nil {
		topologyLog.Error("add topology connection failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建拓扑连接失败")
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Data: connection})
}

func (h *TopologyHandler) DeleteConnection(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	connectionID := chi.URLParam(r, "connectionId")
	if err := h.topology.DeleteConnection(r.Context(), wsID, connectionID); err != nil {
		topologyLog.Error("delete topology connection failed", zap.String("wsId", wsID), zap.String("connectionId", connectionID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除拓扑连接失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
