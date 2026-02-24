package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	workspacepb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/workspace"
)

type WorkspaceHandler struct {
	clients *grpcclient.Clients
}

func NewWorkspaceHandler(clients *grpcclient.Clients) *WorkspaceHandler {
	return &WorkspaceHandler{clients: clients}
}

func (h *WorkspaceHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *WorkspaceHandler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	resp, err := h.clients.Workspace.GetWorkspace(r.Context(), &workspacepb.GetWorkspaceRequest{
		WorkspaceId: wsID, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *WorkspaceHandler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var body workspacepb.CreateWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Workspace.CreateWorkspace(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (h *WorkspaceHandler) UpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body workspacepb.UpdateWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.WorkspaceId = wsID
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Workspace.UpdateWorkspace(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *WorkspaceHandler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	_, err := h.clients.Workspace.DeleteWorkspace(r.Context(), &workspacepb.DeleteWorkspaceRequest{
		WorkspaceId: wsID, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
