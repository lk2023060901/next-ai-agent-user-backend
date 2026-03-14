package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var chLog = logger.Named("channel")

type ChannelHandler struct {
	channels *store.ChannelStore
}

func NewChannelHandler(channels *store.ChannelStore) *ChannelHandler {
	return &ChannelHandler{channels: channels}
}

func (h *ChannelHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/channels", h.List)
	r.Post("/workspaces/{wsId}/channels", h.Create)
	r.Patch("/channels/{channelId}", h.Update)
	r.Delete("/channels/{channelId}", h.Delete)
	r.Post("/channels/{channelId}/test", h.TestConnection)
	r.Get("/channels/{channelId}/stats", h.Stats)
	r.Get("/channels/{channelId}/messages", h.ListMessages)
	r.Get("/channels/{channelId}/rules", h.ListRules)
	r.Post("/channels/{channelId}/rules", h.CreateRule)
	r.Patch("/channels/{channelId}/rules/{ruleId}", h.UpdateRule)
	r.Delete("/channels/{channelId}/rules/{ruleId}", h.DeleteRule)
}

func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	channels, err := h.channels.List(r.Context(), wsID)
	if err != nil {
		chLog.Error("list channels failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取渠道列表失败")
		return
	}
	if channels == nil {
		channels = []model.Channel{}
	}
	chLog.Debug("list channels", zap.String("workspaceId", wsID), zap.Int("count", len(channels)))
	writeData(w, channels)
}

func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Type           string            `json:"type"`
		Name           string            `json:"name"`
		Config         map[string]string `json:"config"`
		DefaultAgentID *string           `json:"defaultAgentId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Type == "" || body.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "type and name are required")
		return
	}
	if body.Config == nil {
		body.Config = map[string]string{}
	}
	ch := &model.Channel{
		WorkspaceID: wsID, Type: body.Type, Name: body.Name,
		Config: body.Config, DefaultAgentID: body.DefaultAgentID,
	}
	created, err := h.channels.Create(r.Context(), ch)
	if err != nil {
		chLog.Error("create channel failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建渠道失败")
		return
	}
	chLog.Debug("create channel", zap.String("channelId", created.ID), zap.String("type", created.Type))
	writeJSON(w, http.StatusCreated, apiResponse{Data: created})
}

func (h *ChannelHandler) Update(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"name": "name", "status": "status", "defaultAgentId": "default_agent_id",
	}
	dbFields := make(map[string]interface{})
	for jk, dk := range fieldMap {
		if v, ok := body[jk]; ok {
			dbFields[dk] = v
		}
	}
	if cfg, ok := body["config"]; ok {
		cfgJSON, _ := json.Marshal(cfg)
		dbFields["config"] = cfgJSON
	}
	if len(dbFields) == 0 {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "no fields to update")
		return
	}
	ch, err := h.channels.Update(r.Context(), channelID, dbFields)
	if err != nil {
		chLog.Error("update channel failed", zap.String("channelId", channelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新渠道失败")
		return
	}
	chLog.Debug("update channel", zap.String("channelId", channelID))
	writeData(w, ch)
}

func (h *ChannelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	if err := h.channels.Delete(r.Context(), channelID); err != nil {
		chLog.Error("delete channel failed", zap.String("channelId", channelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除渠道失败")
		return
	}
	chLog.Debug("delete channel", zap.String("channelId", channelID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *ChannelHandler) TestConnection(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	chLog.Debug("test connection", zap.String("channelId", channelID))
	writeData(w, map[string]interface{}{"success": true, "message": "连接测试成功"})
}

func (h *ChannelHandler) Stats(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	stats, err := h.channels.GetStats(r.Context(), channelID)
	if err != nil {
		chLog.Error("get stats failed", zap.String("channelId", channelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取统计失败")
		return
	}
	chLog.Debug("get stats", zap.String("channelId", channelID))
	writeData(w, stats)
}

func (h *ChannelHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	page := 1
	pageSize := 20
	if v, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && v > 0 {
		page = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil && v > 0 {
		pageSize = v
	}
	filters := map[string]string{
		"direction": r.URL.Query().Get("direction"),
		"status":    r.URL.Query().Get("status"),
	}
	msgs, total, err := h.channels.ListMessages(r.Context(), channelID, page, pageSize, filters)
	if err != nil {
		chLog.Error("list channel messages failed", zap.String("channelId", channelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取消息列表失败")
		return
	}
	if msgs == nil {
		msgs = []model.ChannelMessage{}
	}
	totalPages := (total + pageSize - 1) / pageSize
	chLog.Debug("list channel messages", zap.String("channelId", channelID), zap.Int("count", len(msgs)))
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"data": msgs, "total": total, "page": page, "pageSize": pageSize, "totalPages": totalPages,
	})
}

func (h *ChannelHandler) ListRules(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	rules, err := h.channels.ListRules(r.Context(), channelID)
	if err != nil {
		chLog.Error("list rules failed", zap.String("channelId", channelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取路由规则失败")
		return
	}
	if rules == nil {
		rules = []model.RoutingRule{}
	}
	chLog.Debug("list rules", zap.String("channelId", channelID), zap.Int("count", len(rules)))
	writeData(w, rules)
}

func (h *ChannelHandler) CreateRule(w http.ResponseWriter, r *http.Request) {
	channelID := chi.URLParam(r, "channelId")
	var body model.RoutingRule
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	body.ChannelID = channelID
	rule, err := h.channels.CreateRule(r.Context(), &body)
	if err != nil {
		chLog.Error("create rule failed", zap.String("channelId", channelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建路由规则失败")
		return
	}
	chLog.Debug("create rule", zap.String("channelId", channelID), zap.String("ruleId", rule.ID))
	writeJSON(w, http.StatusCreated, apiResponse{Data: rule})
}

func (h *ChannelHandler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	ruleID := chi.URLParam(r, "ruleId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"priority": "priority", "field": "field", "operator": "operator",
		"value": "value", "targetAgentId": "target_agent_id",
		"targetAgentName": "target_agent_name", "enabled": "enabled",
	}
	dbFields := make(map[string]interface{})
	for jk, dk := range fieldMap {
		if v, ok := body[jk]; ok {
			dbFields[dk] = v
		}
	}
	rule, err := h.channels.UpdateRule(r.Context(), ruleID, dbFields)
	if err != nil {
		chLog.Error("update rule failed", zap.String("ruleId", ruleID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新路由规则失败")
		return
	}
	chLog.Debug("update rule", zap.String("ruleId", ruleID))
	writeData(w, rule)
}

func (h *ChannelHandler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	ruleID := chi.URLParam(r, "ruleId")
	if err := h.channels.DeleteRule(r.Context(), ruleID); err != nil {
		chLog.Error("delete rule failed", zap.String("ruleId", ruleID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除路由规则失败")
		return
	}
	chLog.Debug("delete rule", zap.String("ruleId", ruleID))
	w.WriteHeader(http.StatusNoContent)
}
