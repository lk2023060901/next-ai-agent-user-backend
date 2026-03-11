package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	workspacepb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/workspace"
)

type WorkspaceHandler struct {
	clients *grpcclient.Clients
}

func NewWorkspaceHandler(clients *grpcclient.Clients) *WorkspaceHandler {
	return &WorkspaceHandler{clients: clients}
}


func mapWorkspacePayload(item *workspacepb.Workspace) map[string]any {
	if item == nil {
		return map[string]any{}
	}
	id := strings.TrimSpace(item.GetId())
	slug := strings.TrimSpace(item.GetSlug())
	return map[string]any{
		"id":          id,
		"workspaceId": id,
		"slug":        slug,
		"wsSlug":      slug,
		"name":        strings.TrimSpace(item.GetName()),
		"emoji":       strings.TrimSpace(item.GetEmoji()),
		"orgId":       strings.TrimSpace(item.GetOrgId()),
		"description": strings.TrimSpace(item.GetDescription()),
		"createdAt":   strings.TrimSpace(item.GetCreatedAt()),
		"updatedAt":   strings.TrimSpace(item.GetUpdatedAt()),
	}
}

func (h *WorkspaceHandler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Workspace.GetWorkspace(r.Context(), &workspacepb.GetWorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: userCtxFromRequest(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, mapWorkspacePayload(resp))
}

func (h *WorkspaceHandler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var body workspacepb.CreateWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.UserContext = userCtxFromRequest(r)
	resp, err := h.clients.Workspace.CreateWorkspace(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusCreated, mapWorkspacePayload(resp))
}

func (h *WorkspaceHandler) UpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	var body workspacepb.UpdateWorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = userCtxFromRequest(r)
	resp, err := h.clients.Workspace.UpdateWorkspace(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, mapWorkspacePayload(resp))
}

func (h *WorkspaceHandler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Workspace.DeleteWorkspace(r.Context(), &workspacepb.DeleteWorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: userCtxFromRequest(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	w.WriteHeader(http.StatusNoContent)
}
