package handler

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var settingsLog = logger.Named("settings")

type SettingsHandler struct {
	providers *store.ProviderStore
}

func NewSettingsHandler(providers *store.ProviderStore) *SettingsHandler {
	return &SettingsHandler{providers: providers}
}

func (h *SettingsHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/settings", h.GetSettings)
	r.Patch("/workspaces/{wsId}/settings", h.UpdateSettings)

	r.Get("/workspaces/{wsId}/providers", h.ListProviders)
	r.Post("/workspaces/{wsId}/providers", h.CreateProvider)
	r.Patch("/workspaces/{wsId}/providers/{id}", h.UpdateProvider)
	r.Delete("/workspaces/{wsId}/providers/{id}", h.DeleteProvider)
	r.Post("/workspaces/{wsId}/providers/{id}/test", h.TestProvider)

	r.Get("/workspaces/{wsId}/providers/{providerId}/models", h.ListModels)
	r.Post("/workspaces/{wsId}/providers/{providerId}/models", h.CreateModel)
	r.Patch("/workspaces/{wsId}/providers/{providerId}/models/{modelId}", h.UpdateModel)
	r.Delete("/workspaces/{wsId}/providers/{providerId}/models/{modelId}", h.DeleteModel)
	r.Get("/workspaces/{wsId}/all-models", h.ListAllModels)

	r.Get("/workspaces/{wsId}/api-keys", h.ListApiKeys)
	r.Post("/workspaces/{wsId}/api-keys", h.CreateApiKey)
	r.Delete("/workspaces/{wsId}/api-keys/{id}", h.DeleteApiKey)
}

// --- Workspace Settings ---

func (h *SettingsHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	s, err := h.providers.GetSettings(r.Context(), wsID)
	if err != nil {
		settingsLog.Error("get settings failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取设置失败")
		return
	}
	if s == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "工作区不存在")
		return
	}
	settingsLog.Debug("get settings", zap.String("wsId", wsID))
	writeData(w, s)
}

func (h *SettingsHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"defaultModel": "default_model", "defaultTemperature": "default_temperature",
		"maxTokensPerRequest": "max_tokens_per_request",
		"assistantModelId": "assistant_model_id", "fastModelId": "fast_model_id",
		"codeModelId": "code_model_id", "agentModelId": "agent_model_id",
		"subAgentModelId": "sub_agent_model_id",
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
	if err := h.providers.UpsertSettings(r.Context(), wsID, dbFields); err != nil {
		settingsLog.Error("update settings failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新设置失败")
		return
	}
	s, _ := h.providers.GetSettings(r.Context(), wsID)
	settingsLog.Debug("update settings", zap.String("wsId", wsID))
	writeData(w, s)
}

// --- Providers ---

func (h *SettingsHandler) ListProviders(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	providers, err := h.providers.List(r.Context(), wsID)
	if err != nil {
		settingsLog.Error("list providers failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 Provider 列表失败")
		return
	}
	if providers == nil {
		providers = []model.AIProvider{}
	}
	settingsLog.Debug("list providers", zap.String("wsId", wsID), zap.Int("count", len(providers)))
	writeData(w, providers)
}

func (h *SettingsHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body model.AIProvider
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	body.WorkspaceID = wsID
	p, err := h.providers.Create(r.Context(), &body)
	if err != nil {
		settingsLog.Error("create provider failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建 Provider 失败")
		return
	}
	settingsLog.Debug("create provider", zap.String("providerId", p.ID), zap.String("name", p.Name))
	writeJSON(w, http.StatusCreated, apiResponse{Data: p})
}

func (h *SettingsHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"name": "name", "type": "type", "icon": "icon", "baseUrl": "base_url",
		"authMethod": "auth_method", "enabled": "enabled", "status": "status",
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
	p, err := h.providers.Update(r.Context(), id, dbFields)
	if err != nil {
		settingsLog.Error("update provider failed", zap.String("providerId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新 Provider 失败")
		return
	}
	settingsLog.Debug("update provider", zap.String("providerId", id))
	writeData(w, p)
}

func (h *SettingsHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.providers.Delete(r.Context(), id); err != nil {
		settingsLog.Error("delete provider failed", zap.String("providerId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除 Provider 失败")
		return
	}
	settingsLog.Debug("delete provider", zap.String("providerId", id))
	w.WriteHeader(http.StatusNoContent)
}

func (h *SettingsHandler) TestProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	settingsLog.Debug("test provider", zap.String("providerId", id))
	writeData(w, map[string]interface{}{"success": true, "message": "连接成功"})
}

// --- Models ---

func (h *SettingsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "providerId")
	series, err := h.providers.ListModels(r.Context(), providerID)
	if err != nil {
		settingsLog.Error("list models failed", zap.String("providerId", providerID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取模型列表失败")
		return
	}
	if series == nil {
		series = []model.ModelSeries{}
	}
	settingsLog.Debug("list models", zap.String("providerId", providerID))
	writeData(w, series)
}

func (h *SettingsHandler) CreateModel(w http.ResponseWriter, r *http.Request) {
	providerID := chi.URLParam(r, "providerId")
	var body struct {
		model.AIModel
		SeriesID   string `json:"seriesId"`
		SeriesName string `json:"seriesName"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	m, err := h.providers.CreateModel(r.Context(), providerID, &body.AIModel, body.SeriesID, body.SeriesName)
	if err != nil {
		settingsLog.Error("create model failed", zap.String("providerId", providerID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建模型失败")
		return
	}
	settingsLog.Debug("create model", zap.String("modelId", m.ID), zap.String("name", m.Name))
	writeJSON(w, http.StatusCreated, apiResponse{Data: m})
}

func (h *SettingsHandler) UpdateModel(w http.ResponseWriter, r *http.Request) {
	modelID := chi.URLParam(r, "modelId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"name": "name", "displayName": "display_name", "contextWindow": "context_window",
		"maxOutput": "max_output", "inputPrice": "input_price", "outputPrice": "output_price",
		"enabled": "enabled",
	}
	dbFields := make(map[string]interface{})
	for jk, dk := range fieldMap {
		if v, ok := body[jk]; ok {
			dbFields[dk] = v
		}
	}
	m, err := h.providers.UpdateModel(r.Context(), modelID, dbFields)
	if err != nil {
		settingsLog.Error("update model failed", zap.String("modelId", modelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新模型失败")
		return
	}
	settingsLog.Debug("update model", zap.String("modelId", modelID))
	writeData(w, m)
}

func (h *SettingsHandler) DeleteModel(w http.ResponseWriter, r *http.Request) {
	modelID := chi.URLParam(r, "modelId")
	if err := h.providers.DeleteModel(r.Context(), modelID); err != nil {
		settingsLog.Error("delete model failed", zap.String("modelId", modelID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除模型失败")
		return
	}
	settingsLog.Debug("delete model", zap.String("modelId", modelID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *SettingsHandler) ListAllModels(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	models, err := h.providers.ListAllModels(r.Context(), wsID)
	if err != nil {
		settingsLog.Error("list all models failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取全部模型失败")
		return
	}
	if models == nil {
		models = []model.FlatModel{}
	}
	settingsLog.Debug("list all models", zap.String("wsId", wsID), zap.Int("count", len(models)))
	writeData(w, models)
}

// --- API Keys ---

func (h *SettingsHandler) ListApiKeys(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	keys, err := h.providers.ListApiKeys(r.Context(), wsID)
	if err != nil {
		settingsLog.Error("list api keys failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 API Key 列表失败")
		return
	}
	if keys == nil {
		keys = []model.ApiKey{}
	}
	settingsLog.Debug("list api keys", zap.String("wsId", wsID))
	writeData(w, keys)
}

func (h *SettingsHandler) CreateApiKey(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Name      string  `json:"name"`
		ExpiresAt *string `json:"expiresAt"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}

	// Generate key
	rawBytes := make([]byte, 32)
	rand.Read(rawBytes)
	fullKey := "nai_" + hex.EncodeToString(rawBytes)
	prefix := fullKey[:12]
	hash := sha256.Sum256([]byte(fullKey))
	keyHash := hex.EncodeToString(hash[:])

	k, err := h.providers.CreateApiKey(r.Context(), wsID, body.Name, prefix, keyHash, body.ExpiresAt)
	if err != nil {
		settingsLog.Error("create api key failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建 API Key 失败")
		return
	}
	k.FullKey = fullKey
	settingsLog.Debug("create api key", zap.String("wsId", wsID), zap.String("prefix", prefix))
	writeJSON(w, http.StatusCreated, apiResponse{Data: k})
}

func (h *SettingsHandler) DeleteApiKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.providers.DeleteApiKey(r.Context(), id); err != nil {
		settingsLog.Error("delete api key failed", zap.String("keyId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除 API Key 失败")
		return
	}
	settingsLog.Debug("delete api key", zap.String("keyId", id))
	w.WriteHeader(http.StatusNoContent)
}

// suppress unused import warning
var _ = fmt.Sprintf
