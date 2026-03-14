package handler

import (
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var agentLog = logger.Named("agent")

type AgentHandler struct {
	agents *store.AgentStore
}

func NewAgentHandler(agents *store.AgentStore) *AgentHandler {
	return &AgentHandler{agents: agents}
}

func (h *AgentHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/agents", h.List)
	r.Post("/workspaces/{wsId}/agents", h.Create)
	r.Get("/agents/{id}", h.Get)
	r.Patch("/agents/{id}", h.Update)
	r.Delete("/agents/{id}", h.Delete)
}

func (h *AgentHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	agents, err := h.agents.List(r.Context(), wsID)
	if err != nil {
		agentLog.Error("list agents failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 Agent 列表失败")
		return
	}
	if agents == nil {
		agents = []model.Agent{}
	}
	agentLog.Debug("list agents", zap.String("workspaceId", wsID), zap.Int("count", len(agents)))
	writeData(w, agents)
}

func (h *AgentHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	agent, err := h.agents.GetByID(r.Context(), id)
	if err != nil {
		agentLog.Error("get agent failed", zap.String("agentId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 Agent 失败")
		return
	}
	if agent == nil {
		agentLog.Debug("agent not found", zap.String("agentId", id))
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Agent 不存在")
		return
	}
	agentLog.Debug("get agent", zap.String("agentId", id))
	writeData(w, agent)
}

func (h *AgentHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Name           string   `json:"name"`
		Role           string   `json:"role"`
		Model          string   `json:"model"`
		ModelID        *string  `json:"modelId"`
		SystemPrompt   *string  `json:"systemPrompt"`
		Description    *string  `json:"description"`
		Avatar         *string  `json:"avatar"`
		Color          *string  `json:"color"`
		Identifier     *string  `json:"identifier"`
		ConfigJSON     *string  `json:"configJson"`
		KnowledgeBases []string `json:"knowledgeBases"`
	}
	if err := decodeBody(r, &body); err != nil {
		agentLog.Warn("create agent: invalid body", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}
	if body.Role == "" {
		body.Role = "coordinator"
	}

	agent := &model.Agent{
		WorkspaceID: wsID, Name: body.Name, Role: body.Role, Status: "idle",
		Model: body.Model, ModelID: body.ModelID, SystemPrompt: body.SystemPrompt,
		Description: body.Description, Avatar: body.Avatar, Color: body.Color,
		Identifier: body.Identifier, ConfigJSON: body.ConfigJSON, KnowledgeBases: body.KnowledgeBases,
	}

	created, err := h.agents.Create(r.Context(), agent)
	if err != nil {
		agentLog.Error("create agent failed", zap.String("workspaceId", wsID), zap.String("name", body.Name), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建 Agent 失败")
		return
	}
	agentLog.Debug("create agent", zap.String("agentId", created.ID), zap.String("name", created.Name))
	writeJSON(w, http.StatusCreated, apiResponse{Data: created})
}

func (h *AgentHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		agentLog.Warn("update agent: invalid body", zap.String("agentId", id), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}

	fieldMap := map[string]string{
		"name": "name", "role": "role", "model": "model", "modelId": "model_id",
		"systemPrompt": "system_prompt", "description": "description", "avatar": "avatar",
		"color": "color", "identifier": "identifier", "configJson": "config_json", "status": "status",
	}
	dbFields := make(map[string]interface{})
	for jk, dk := range fieldMap {
		if v, ok := body[jk]; ok {
			dbFields[dk] = v
		}
	}
	if len(dbFields) == 0 {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "no fields to update")
		return
	}

	updated, err := h.agents.Update(r.Context(), id, dbFields)
	if err != nil {
		agentLog.Error("update agent failed", zap.String("agentId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新 Agent 失败")
		return
	}
	agentLog.Debug("update agent", zap.String("agentId", id))
	writeData(w, updated)
}

func (h *AgentHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.agents.Delete(r.Context(), id); err != nil {
		agentLog.Error("delete agent failed", zap.String("agentId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除 Agent 失败")
		return
	}
	agentLog.Debug("delete agent", zap.String("agentId", id))
	w.WriteHeader(http.StatusNoContent)
}
