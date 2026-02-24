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
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettingsHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var body settingspb.CreateProviderRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Settings.CreateProvider(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusCreated, resp)
}

func (h *SettingsHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	var body settingspb.UpdateProviderRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.Id = chi.URLParam(r, "providerId")
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Settings.UpdateProvider(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettingsHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Settings.DeleteProvider(r.Context(), &settingspb.ResourceRequest{
		Id: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	w.WriteHeader(http.StatusNoContent)
}

// ── Models ────────────────────────────────────────────────────────────────────

func (h *SettingsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListModels(r.Context(), &settingspb.ListModelsRequest{
		ProviderId: chi.URLParam(r, "providerId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettingsHandler) ListAllModels(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListAllModels(r.Context(), h.wsReq(r))
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettingsHandler) CreateModel(w http.ResponseWriter, r *http.Request) {
	var body settingspb.CreateModelRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.ProviderId = chi.URLParam(r, "providerId")
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Settings.CreateModel(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusCreated, resp)
}

func (h *SettingsHandler) UpdateModel(w http.ResponseWriter, r *http.Request) {
	var body settingspb.UpdateModelRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.Id = chi.URLParam(r, "modelId")
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Settings.UpdateModel(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettingsHandler) DeleteModel(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Settings.DeleteModel(r.Context(), &settingspb.ResourceRequest{
		Id: chi.URLParam(r, "modelId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	w.WriteHeader(http.StatusNoContent)
}

// ── API Keys ──────────────────────────────────────────────────────────────────

func (h *SettingsHandler) ListApiKeys(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Settings.ListApiKeys(r.Context(), h.wsReq(r))
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettingsHandler) CreateApiKey(w http.ResponseWriter, r *http.Request) {
	var body settingspb.CreateApiKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Settings.CreateApiKey(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeJSON(w, http.StatusCreated, resp)
}

func (h *SettingsHandler) DeleteApiKey(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Settings.DeleteApiKey(r.Context(), &settingspb.ResourceRequest{
		Id: chi.URLParam(r, "keyId"), WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	w.WriteHeader(http.StatusNoContent)
}
