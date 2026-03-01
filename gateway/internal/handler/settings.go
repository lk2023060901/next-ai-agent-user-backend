package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	settingspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/settings"
)

type SettingsHandler struct {
	clients *grpcclient.Clients
}

type providerView struct {
	ID            string `json:"id"`
	WorkspaceID   string `json:"workspaceId"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	Icon          string `json:"icon"`
	BaseURL       string `json:"baseUrl"`
	AuthMethod    string `json:"authMethod"`
	SupportsOAuth bool   `json:"supportsOAuth"`
	Enabled       bool   `json:"enabled"`
	Status        string `json:"status"`
	ModelCount    int32  `json:"modelCount"`
	CreatedAt     string `json:"createdAt"`
}

type modelView struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	DisplayName   string   `json:"displayName"`
	ContextWindow int32    `json:"contextWindow"`
	MaxOutput     int32    `json:"maxOutput"`
	InputPrice    float64  `json:"inputPrice"`
	OutputPrice   float64  `json:"outputPrice"`
	Capabilities  []string `json:"capabilities"`
	Enabled       bool     `json:"enabled"`
}

type modelSeriesView struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Models []modelView `json:"models"`
}

type workspaceSettingsView struct {
	ID                  string  `json:"id"`
	Name                string  `json:"name"`
	Description         string  `json:"description"`
	DefaultModel        string  `json:"defaultModel"`
	DefaultTemperature  float64 `json:"defaultTemperature"`
	MaxTokensPerRequest int32   `json:"maxTokensPerRequest"`
	AssistantModelID    any     `json:"assistantModelId"`
	FastModelID         any     `json:"fastModelId"`
	CodeModelID         any     `json:"codeModelId"`
	AgentModelID        any     `json:"agentModelId"`
	SubAgentModelID     any     `json:"subAgentModelId"`
}

func NewSettingsHandler(clients *grpcclient.Clients) *SettingsHandler {
	return &SettingsHandler{clients: clients}
}

func providerDefaults(providerType string) (icon string, supportsOAuth bool, authMethod string) {
	switch strings.ToLower(strings.TrimSpace(providerType)) {
	case "openai":
		return "🤖", false, "api_key"
	case "anthropic":
		return "🧠", false, "api_key"
	case "google":
		return "🌐", true, "api_key"
	case "azure_openai":
		return "☁️", true, "api_key"
	case "deepseek":
		return "🔍", false, "api_key"
	case "zhipu":
		return "🧪", false, "api_key"
	case "qwen":
		return "🌀", false, "api_key"
	default:
		return "⚙️", false, "api_key"
	}
}

func normalizeProviderStatus(raw string) (status string, enabled bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "disabled", "inactive":
		return "disabled", false
	case "error":
		return "error", true
	default:
		return "active", true
	}
}

func mapProviderToView(p *settingspb.Provider, modelCount int32) providerView {
	status, enabled := normalizeProviderStatus(p.GetStatus())
	icon, supportsOAuth, authMethod := providerDefaults(p.GetType())
	return providerView{
		ID:            p.GetId(),
		WorkspaceID:   p.GetWorkspaceId(),
		Name:          p.GetName(),
		Type:          p.GetType(),
		Icon:          icon,
		BaseURL:       p.GetBaseUrl(),
		AuthMethod:    authMethod,
		SupportsOAuth: supportsOAuth,
		Enabled:       enabled,
		Status:        status,
		ModelCount:    modelCount,
		CreatedAt:     p.GetCreatedAt(),
	}
}

func mapSeriesToView(series []*settingspb.ModelSeries) []modelSeriesView {
	out := make([]modelSeriesView, 0, len(series))
	for _, s := range series {
		if s == nil {
			continue
		}
		models := s.GetModels()
		modelOut := make([]modelView, 0, len(models))
		for _, m := range models {
			if m == nil {
				continue
			}
			capabilities := m.GetCapabilities()
			if capabilities == nil {
				capabilities = []string{}
			}
			modelOut = append(modelOut, modelView{
				ID:            m.GetId(),
				Name:          m.GetName(),
				DisplayName:   m.GetDisplayName(),
				ContextWindow: m.GetContextWindow(),
				MaxOutput:     m.GetMaxOutput(),
				InputPrice:    m.GetInputPrice(),
				OutputPrice:   m.GetOutputPrice(),
				Capabilities:  capabilities,
				Enabled:       m.GetEnabled(),
			})
		}
		out = append(out, modelSeriesView{
			ID:     s.GetId(),
			Name:   s.GetName(),
			Models: modelOut,
		})
	}
	if out == nil {
		return []modelSeriesView{}
	}
	return out
}

func (h *SettingsHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *SettingsHandler) wsReq(r *http.Request) *settingspb.WorkspaceRequest {
	return &settingspb.WorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		UserContext: h.userCtx(r),
	}
}

func modelFieldValue(ids []string) any {
	if len(ids) == 1 {
		return ids[0]
	}
	if ids == nil {
		return []string{}
	}
	return ids
}

func mapWorkspaceSettingsToView(resp *settingspb.WorkspaceSettings) workspaceSettingsView {
	return workspaceSettingsView{
		ID:                  resp.GetId(),
		Name:                resp.GetName(),
		Description:         resp.GetDescription(),
		DefaultModel:        resp.GetDefaultModel(),
		DefaultTemperature:  resp.GetDefaultTemperature(),
		MaxTokensPerRequest: resp.GetMaxTokensPerRequest(),
		AssistantModelID:    modelFieldValue(resp.GetAssistantModelIds()),
		FastModelID:         modelFieldValue(resp.GetFallbackModelIds()),
		CodeModelID:         modelFieldValue(resp.GetCodeModelIds()),
		AgentModelID:        modelFieldValue(resp.GetAgentModelIds()),
		SubAgentModelID:     modelFieldValue(resp.GetSubAgentModelIds()),
	}
}

func readStringField(body map[string]any, key string) (string, bool) {
	raw, ok := body[key]
	if !ok {
		return "", false
	}
	if value, ok := raw.(string); ok {
		return strings.TrimSpace(value), true
	}
	return "", true
}

func readFloatField(body map[string]any, key string) (float64, bool) {
	raw, ok := body[key]
	if !ok {
		return 0, false
	}
	switch value := raw.(type) {
	case float64:
		return value, true
	case float32:
		return float64(value), true
	case int:
		return float64(value), true
	case int32:
		return float64(value), true
	case int64:
		return float64(value), true
	default:
		return 0, true
	}
}

func readInt32Field(body map[string]any, key string) (int32, bool) {
	raw, ok := body[key]
	if !ok {
		return 0, false
	}
	switch value := raw.(type) {
	case float64:
		return int32(value), true
	case float32:
		return int32(value), true
	case int:
		return int32(value), true
	case int32:
		return value, true
	case int64:
		return int32(value), true
	default:
		return 0, true
	}
}

func readStringListField(body map[string]any, key string) ([]string, bool) {
	raw, ok := body[key]
	if !ok {
		return nil, false
	}

	normalize := func(items []string) []string {
		out := make([]string, 0, len(items))
		seen := make(map[string]struct{}, len(items))
		for _, item := range items {
			normalized := strings.TrimSpace(item)
			if normalized == "" {
				continue
			}
			if _, exists := seen[normalized]; exists {
				continue
			}
			seen[normalized] = struct{}{}
			out = append(out, normalized)
		}
		return out
	}

	switch value := raw.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return []string{}, true
		}
		return []string{strings.TrimSpace(value)}, true
	case []string:
		return normalize(value), true
	case []any:
		items := make([]string, 0, len(value))
		for _, item := range value {
			if s, ok := item.(string); ok {
				items = append(items, s)
			}
		}
		return normalize(items), true
	default:
		return []string{}, true
	}
}

// ── Workspace Settings ───────────────────────────────────────────────────────

func (h *SettingsHandler) GetWorkspaceSettings(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.GetWorkspaceSettings(r.Context(), h.wsReq(r))
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, mapWorkspaceSettingsToView(resp))
}

func (h *SettingsHandler) UpdateWorkspaceSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req := &settingspb.UpdateWorkspaceSettingsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		UserContext: h.userCtx(r),
	}

	if value, ok := readStringField(body, "name"); ok {
		req.Name = value
		req.SetName = true
	}
	if value, ok := readStringField(body, "description"); ok {
		req.Description = value
		req.SetDescription = true
	}
	if value, ok := readStringField(body, "defaultModel"); ok {
		req.DefaultModel = value
		req.SetDefaultModel = true
	}
	if value, ok := readFloatField(body, "defaultTemperature"); ok {
		req.DefaultTemperature = value
		req.SetDefaultTemperature = true
	}
	if value, ok := readInt32Field(body, "maxTokensPerRequest"); ok {
		req.MaxTokensPerRequest = value
		req.SetMaxTokensPerRequest = true
	}
	if value, ok := readStringListField(body, "assistantModelId"); ok {
		req.AssistantModelIds = value
		req.SetAssistantModelIds = true
	}
	if value, ok := readStringListField(body, "fastModelId"); ok {
		req.FallbackModelIds = value
		req.SetFallbackModelIds = true
	}
	if value, ok := readStringListField(body, "codeModelId"); ok {
		req.CodeModelIds = value
		req.SetCodeModelIds = true
	}
	if value, ok := readStringListField(body, "agentModelId"); ok {
		req.AgentModelIds = value
		req.SetAgentModelIds = true
	}
	if value, ok := readStringListField(body, "subAgentModelId"); ok {
		req.SubAgentModelIds = value
		req.SetSubAgentModelIds = true
	}

	resp, err := h.clients.Settings.UpdateWorkspaceSettings(r.Context(), req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, mapWorkspaceSettingsToView(resp))
}

// ── Providers ─────────────────────────────────────────────────────────────────

func (h *SettingsHandler) ListProviders(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListProviders(r.Context(), h.wsReq(r))
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	out := make([]providerView, 0, len(resp.Providers))
	for _, p := range resp.Providers {
		if p == nil {
			continue
		}
		modelCount := int32(0)
		modelsResp, listErr := h.clients.Settings.ListModels(r.Context(), &settingspb.ListModelsRequest{
			ProviderId: p.GetId(), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
		})
		if listErr == nil {
			modelCount = int32(len(modelsResp.GetModels()))
		}
		out = append(out, mapProviderToView(p, modelCount))
	}
	writeData(w, http.StatusOK, out)
}

func (h *SettingsHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		ApiKey  string `json:"apiKey"`
		BaseUrl string `json:"baseUrl"`
		Enabled *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Settings.CreateProvider(r.Context(), &settingspb.CreateProviderRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Name:        body.Name,
		Type:        body.Type,
		ApiKey:      body.ApiKey,
		BaseUrl:     body.BaseUrl,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	created := mapProviderToView(resp, 0)
	if body.Enabled != nil {
		created.Enabled = *body.Enabled
		if *body.Enabled {
			created.Status = "active"
		} else {
			created.Status = "disabled"
		}
	}
	writeData(w, http.StatusCreated, created)
}

func (h *SettingsHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		ApiKey  string `json:"apiKey"`
		BaseUrl string `json:"baseUrl"`
		Status  string `json:"status"`
		Enabled *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	status := strings.TrimSpace(body.Status)
	if body.Enabled != nil {
		if *body.Enabled {
			status = "active"
		} else {
			status = "disabled"
		}
	}
	resp, err := h.clients.Settings.UpdateProvider(r.Context(), &settingspb.UpdateProviderRequest{
		Id:          chi.URLParam(r, "providerId"),
		WorkspaceId: chi.URLParam(r, "wsId"),
		Name:        body.Name,
		ApiKey:      body.ApiKey,
		BaseUrl:     body.BaseUrl,
		Status:      status,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	modelCount := int32(0)
	modelsResp, listErr := h.clients.Settings.ListModels(r.Context(), &settingspb.ListModelsRequest{
		ProviderId: resp.GetId(), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if listErr == nil {
		modelCount = int32(len(modelsResp.GetModels()))
	}
	writeData(w, http.StatusOK, mapProviderToView(resp, modelCount))
}

func (h *SettingsHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Settings.DeleteProvider(r.Context(), &settingspb.ResourceRequest{
		Id: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Models ────────────────────────────────────────────────────────────────────

func (h *SettingsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListModelSeries(r.Context(), &settingspb.ListModelsRequest{
		ProviderId: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, mapSeriesToView(resp.GetSeries()))
}

func (h *SettingsHandler) ListModelCatalog(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListModelCatalog(r.Context(), &settingspb.ListModelsRequest{
		ProviderId: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, mapSeriesToView(resp.GetSeries()))
}

func (h *SettingsHandler) ListAllModels(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListAllModels(r.Context(), h.wsReq(r))
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Models)
}

func (h *SettingsHandler) CreateModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name            string  `json:"name"`
		ContextWindow   int32   `json:"contextWindow"`
		CostPer1kTokens float64 `json:"costPer1kTokens"`
		IsDefault       bool    `json:"isDefault"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Settings.CreateModel(r.Context(), &settingspb.CreateModelRequest{
		ProviderId:       chi.URLParam(r, "providerId"),
		WorkspaceId:      chi.URLParam(r, "wsId"),
		Name:             body.Name,
		ContextWindow:    body.ContextWindow,
		CostPer_1KTokens: body.CostPer1kTokens,
		IsDefault:        body.IsDefault,
		UserContext:      h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, resp)
}

func (h *SettingsHandler) UpdateModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name            string  `json:"name"`
		ContextWindow   int32   `json:"contextWindow"`
		CostPer1kTokens float64 `json:"costPer1kTokens"`
		IsDefault       bool    `json:"isDefault"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Settings.UpdateModel(r.Context(), &settingspb.UpdateModelRequest{
		Id:               chi.URLParam(r, "modelId"),
		WorkspaceId:      chi.URLParam(r, "wsId"),
		Name:             body.Name,
		ContextWindow:    body.ContextWindow,
		CostPer_1KTokens: body.CostPer1kTokens,
		IsDefault:        body.IsDefault,
		UserContext:      h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (h *SettingsHandler) DeleteModel(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Settings.DeleteModel(r.Context(), &settingspb.ResourceRequest{
		Id: chi.URLParam(r, "modelId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── API Keys ──────────────────────────────────────────────────────────────────

func (h *SettingsHandler) ListApiKeys(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListApiKeys(r.Context(), h.wsReq(r))
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.ApiKeys)
}

func (h *SettingsHandler) CreateApiKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string `json:"name"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Settings.CreateApiKey(r.Context(), &settingspb.CreateApiKeyRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Name:        body.Name,
		ExpiresAt:   body.ExpiresAt,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, map[string]any{
		"apiKey": resp.ApiKey,
		"rawKey": resp.RawKey,
	})
}

func (h *SettingsHandler) DeleteApiKey(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Settings.DeleteApiKey(r.Context(), &settingspb.ResourceRequest{
		Id: chi.URLParam(r, "keyId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Test Provider ──────────────────────────────────────────────────────────────

func (h *SettingsHandler) TestProvider(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.TestProvider(r.Context(), &settingspb.TestProviderRequest{
		Id: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, map[string]any{
		"success": resp.Success,
		"message": resp.Message,
	})
}
