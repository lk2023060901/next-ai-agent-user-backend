package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	toolspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/tools"
)

type ToolsHandler struct {
	clients *grpcclient.Clients
}

func NewToolsHandler(clients *grpcclient.Clients) *ToolsHandler {
	return &ToolsHandler{clients: clients}
}

func (h *ToolsHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *ToolsHandler) ListTools(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Tools.ListTools(r.Context(), &toolspb.ListToolsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Category:    r.URL.Query().Get("category"),
		UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Tools)
}

func (h *ToolsHandler) ListToolAuthorizations(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Tools.ListToolAuthorizations(r.Context(), &toolspb.WorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Authorizations)
}

func (h *ToolsHandler) UpsertToolAuthorization(w http.ResponseWriter, r *http.Request) {
	var body toolspb.UpsertToolAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Tools.UpsertToolAuthorization(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp)
}
