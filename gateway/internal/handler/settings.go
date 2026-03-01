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
	writeData(w, http.StatusOK, resp.Series)
}

func (h *SettingsHandler) ListModelCatalog(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListModelCatalog(r.Context(), &settingspb.ListModelsRequest{
		ProviderId: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Series)
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
