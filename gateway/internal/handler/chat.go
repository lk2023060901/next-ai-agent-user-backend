package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

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
		"isPinned":     s.IsPinned,
		"createdAt":    s.CreatedAt,
	}
	if s.LastMessageAt != "" {
		m["lastMessageAt"] = s.LastMessageAt
	}
	if s.PinnedAt != "" {
		m["pinnedAt"] = s.PinnedAt
	}
	return m
}

func agentMap(a *chatpb.AgentItem) map[string]any {
	tools := a.Tools
	if tools == nil {
		tools = []string{}
	}
	knowledgeBases := a.KnowledgeBases
	if knowledgeBases == nil {
		knowledgeBases = []string{}
	}

	out := map[string]any{
		"id":             a.Id,
		"workspaceId":    a.WorkspaceId,
		"name":           a.Name,
		"role":           a.Role,
		"color":          a.Color,
		"status":         a.Status,
		"model":          a.Model,
		"description":    a.Description,
		"systemPrompt":   a.SystemPrompt,
		"temperature":    a.Temperature,
		"outputFormat":   a.OutputFormat,
		"tools":          tools,
		"knowledgeBases": knowledgeBases,
		"createdAt":      a.CreatedAt,
		"updatedAt":      a.UpdatedAt,
	}
	if a.ModelId != "" {
		out["modelId"] = a.ModelId
	}
	return out
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
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	sessions := make([]map[string]any, len(resp.Sessions))
	for i, s := range resp.Sessions {
		sessions[i] = sessionMap(s)
	}
	writeData(w, http.StatusOK, sessions)
}

func (h *ChatHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Chat.CreateSession(r.Context(), &chatpb.CreateSessionRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), Title: body.Title, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, sessionMap(resp))
}

func (h *ChatHandler) UpdateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title    *string `json:"title"`
		IsPinned *bool   `json:"isPinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Title == nil && body.IsPinned == nil {
		writeError(w, http.StatusBadRequest, "no fields to update")
		return
	}

	req := &chatpb.UpdateSessionRequest{
		SessionId:   chi.URLParam(r, "sessionId"),
		UserContext: h.userCtx(r),
	}
	if body.Title != nil {
		req.Title = *body.Title
		req.UpdateTitle = true
	}
	if body.IsPinned != nil {
		req.IsPinned = *body.IsPinned
		req.UpdateIsPinned = true
	}

	resp, err := h.clients.Chat.UpdateSession(r.Context(), req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, sessionMap(resp))
}

func (h *ChatHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Chat.DeleteSession(r.Context(), &chatpb.DeleteSessionRequest{
		SessionId:   chi.URLParam(r, "sessionId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, nil)
}

// ─── Messages ─────────────────────────────────────────────────────────────────

func (h *ChatHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	limit := int32(40)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 100 {
			limit = int32(n)
		}
	}
	beforeMessageId := r.URL.Query().Get("beforeMessageId")

	resp, err := h.clients.Chat.ListMessages(r.Context(), &chatpb.ListMessagesRequest{
		SessionId:       chi.URLParam(r, "sessionId"),
		UserContext:     h.userCtx(r),
		Limit:           limit,
		BeforeMessageId: beforeMessageId,
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	msgs := make([]map[string]any, len(resp.Messages))
	for i, m := range resp.Messages {
		msgs[i] = messageMap(m)
	}
	writeData(w, http.StatusOK, map[string]any{
		"messages":            msgs,
		"hasMore":             resp.HasMore,
		"nextBeforeMessageId": resp.NextBeforeMessageId,
	})
}

func (h *ChatHandler) SaveUserMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Chat.SaveUserMessage(r.Context(), &chatpb.SaveUserMessageRequest{
		SessionId:   chi.URLParam(r, "sessionId"),
		Content:     body.Content,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, messageMap(resp))
}

// ─── Agents ───────────────────────────────────────────────────────────────────

func (h *ChatHandler) ListAgents(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.ListAgents(r.Context(), &chatpb.ListAgentsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	agentList := make([]map[string]any, len(resp.Agents))
	for i, a := range resp.Agents {
		agentList[i] = agentMap(a)
	}
	writeData(w, http.StatusOK, agentList)
}

func (h *ChatHandler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name           string   `json:"name"`
		Role           string   `json:"role"`
		Model          string   `json:"model"`
		ModelID        string   `json:"modelId"`
		Color          string   `json:"color"`
		Description    string   `json:"description"`
		SystemPrompt   string   `json:"systemPrompt"`
		Temperature    float64  `json:"temperature"`
		OutputFormat   string   `json:"outputFormat"`
		Tools          []string `json:"tools"`
		KnowledgeBases []string `json:"knowledgeBases"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Chat.CreateAgent(r.Context(), &chatpb.CreateAgentRequest{
		WorkspaceId:    chi.URLParam(r, "wsId"),
		Name:           body.Name,
		Role:           body.Role,
		Model:          body.Model,
		ModelId:        body.ModelID,
		Color:          body.Color,
		Description:    body.Description,
		SystemPrompt:   body.SystemPrompt,
		Temperature:    body.Temperature,
		OutputFormat:   body.OutputFormat,
		Tools:          body.Tools,
		KnowledgeBases: body.KnowledgeBases,
		UserContext:    h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, agentMap(resp))
}

func (h *ChatHandler) GetAgent(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.GetAgent(r.Context(), &chatpb.GetAgentRequest{
		Id: chi.URLParam(r, "agentId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, agentMap(resp))
}

func (h *ChatHandler) UpdateAgent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name           string   `json:"name"`
		Role           string   `json:"role"`
		Model          string   `json:"model"`
		ModelID        string   `json:"modelId"`
		Color          string   `json:"color"`
		Description    string   `json:"description"`
		SystemPrompt   string   `json:"systemPrompt"`
		Temperature    float64  `json:"temperature"`
		OutputFormat   string   `json:"outputFormat"`
		Tools          []string `json:"tools"`
		KnowledgeBases []string `json:"knowledgeBases"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Chat.UpdateAgent(r.Context(), &chatpb.UpdateAgentRequest{
		Id:             chi.URLParam(r, "agentId"),
		Name:           body.Name,
		Role:           body.Role,
		Model:          body.Model,
		ModelId:        body.ModelID,
		Color:          body.Color,
		Description:    body.Description,
		SystemPrompt:   body.SystemPrompt,
		Temperature:    body.Temperature,
		OutputFormat:   body.OutputFormat,
		Tools:          body.Tools,
		KnowledgeBases: body.KnowledgeBases,
		UserContext:    h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, agentMap(resp))
}

func (h *ChatHandler) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Chat.DeleteAgent(r.Context(), &chatpb.DeleteAgentRequest{
		Id: chi.URLParam(r, "agentId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
