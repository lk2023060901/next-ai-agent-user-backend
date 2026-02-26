package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	chatpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/chat"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
)

type ChatHandler struct {
	clients *grpcclient.Clients
}

func NewChatHandler(clients *grpcclient.Clients) *ChatHandler {
	return &ChatHandler{clients: clients}
}

func (h *ChatHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

// ─── Helpers: camelCase maps ──────────────────────────────────────────────────

func sessionMap(s *chatpb.Session) map[string]any {
	m := map[string]any{
		"id":           s.Id,
		"title":        s.Title,
		"workspaceId":  s.WorkspaceId,
		"status":       s.Status,
		"messageCount": s.MessageCount,
		"createdAt":    s.CreatedAt,
	}
	if s.LastMessageAt != "" {
		m["lastMessageAt"] = s.LastMessageAt
	}
	return m
}

func agentMap(a *chatpb.AgentItem) map[string]any {
	return map[string]any{
		"id":          a.Id,
		"workspaceId": a.WorkspaceId,
		"name":        a.Name,
		"role":        a.Role,
		"color":       a.Color,
		"status":      a.Status,
		"model":       a.Model,
		"description": a.Description,
		"createdAt":   a.CreatedAt,
		"updatedAt":   a.UpdatedAt,
	}
}

func messageMap(m *chatpb.ChatMessage) map[string]any {
	out := map[string]any{
		"id":        m.Id,
		"sessionId": m.SessionId,
		"role":      m.Role,
		"content":   m.Content,
		"status":    m.Status,
		"createdAt": m.CreatedAt,
	}
	if m.AgentId != "" {
		out["agentId"] = m.AgentId
	}
	return out
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

func (h *ChatHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.ListSessions(r.Context(), &chatpb.ListSessionsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }

	sessions := make([]map[string]any, len(resp.Sessions))
	for i, s := range resp.Sessions {
		sessions[i] = sessionMap(s)
	}
	writeData(w, http.StatusOK, sessions)
}

func (h *ChatHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct{ Title string `json:"title"` }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	resp, err := h.clients.Chat.CreateSession(r.Context(), &chatpb.CreateSessionRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), Title: body.Title, UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusCreated, sessionMap(resp))
}

// ─── Messages ─────────────────────────────────────────────────────────────────

func (h *ChatHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.ListMessages(r.Context(), &chatpb.ListMessagesRequest{
		SessionId: chi.URLParam(r, "sessionId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }

	msgs := make([]map[string]any, len(resp.Messages))
	for i, m := range resp.Messages {
		msgs[i] = messageMap(m)
	}
	writeData(w, http.StatusOK, msgs)
}

// ─── Agents ───────────────────────────────────────────────────────────────────

func (h *ChatHandler) ListAgents(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.ListAgents(r.Context(), &chatpb.ListAgentsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }

	agentList := make([]map[string]any, len(resp.Agents))
	for i, a := range resp.Agents {
		agentList[i] = agentMap(a)
	}
	writeData(w, http.StatusOK, agentList)
}

func (h *ChatHandler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	var body chatpb.CreateAgentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Chat.CreateAgent(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusCreated, agentMap(resp))
}
