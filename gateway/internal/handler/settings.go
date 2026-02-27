package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	settingspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/settings"
)

type SettingsHandler struct {
	clients *grpcclient.Clients
}

func NewSettingsHandler(clients *grpcclient.Clients) *SettingsHandler {
	return &SettingsHandler{clients: clients}
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
	writeData(w, http.StatusOK, resp.Providers)
}

func (h *SettingsHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		ApiKey  string `json:"apiKey"`
		BaseUrl string `json:"baseUrl"`
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
	writeData(w, http.StatusCreated, resp)
}

func (h *SettingsHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		ApiKey  string `json:"apiKey"`
		BaseUrl string `json:"baseUrl"`
		Status  string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Settings.UpdateProvider(r.Context(), &settingspb.UpdateProviderRequest{
		Id:          chi.URLParam(r, "providerId"),
		WorkspaceId: chi.URLParam(r, "wsId"),
		Name:        body.Name,
		ApiKey:      body.ApiKey,
		BaseUrl:     body.BaseUrl,
		Status:      body.Status,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp)
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
	resp, err := h.clients.Settings.ListModels(r.Context(), &settingspb.ListModelsRequest{
		ProviderId: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Models)
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
