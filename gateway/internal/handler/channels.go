package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	channelspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/channels"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
)

type ChannelsHandler struct {
	clients       *grpcclient.Clients
	runtimeSecret string
}

func channelMap(item *channelspb.Channel) map[string]any {
	if item == nil {
		return map[string]any{}
	}
	return map[string]any{
		"id":                  strings.TrimSpace(item.GetId()),
		"workspaceId":         strings.TrimSpace(item.GetWorkspaceId()),
		"name":                strings.TrimSpace(item.GetName()),
		"type":                strings.TrimSpace(item.GetType()),
		"status":              strings.TrimSpace(item.GetStatus()),
		"createdAt":           strings.TrimSpace(item.GetCreatedAt()),
		"updatedAt":           strings.TrimSpace(item.GetUpdatedAt()),
		"connectedChannels":   int(item.GetConnectedChannels()),
		"lastActiveAt":        strings.TrimSpace(item.GetLastActiveAt()),
		"realtimeConnected":   item.GetRealtimeConnected(),
		"connectionState":     strings.TrimSpace(item.GetConnectionState()),
		"connectionMode":      strings.TrimSpace(item.GetConnectionMode()),
		"lastConnectedAt":     strings.TrimSpace(item.GetLastConnectedAt()),
		"connectionLastError": strings.TrimSpace(item.GetConnectionLastError()),
		"config":              map[string]string{},
	}
}

func NewChannelsHandler(clients *grpcclient.Clients, runtimeSecret string) *ChannelsHandler {
	return &ChannelsHandler{clients: clients, runtimeSecret: runtimeSecret}
}

func (h *ChannelsHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *ChannelsHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Channels.ListChannels(r.Context(), &channelspb.WorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(resp.GetChannels()))
	for _, item := range resp.GetChannels() {
		items = append(items, channelMap(item))
	}
	writeData(w, http.StatusOK, items)
}

func (h *ChannelsHandler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string         `json:"name"`
		Type       string         `json:"type"`
		Config     map[string]any `json:"config"`
		ConfigJSON string         `json:"configJson"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "channel name is required")
		return
	}
	configJSON := strings.TrimSpace(body.ConfigJSON)
	if configJSON == "" && body.Config != nil {
		if encoded, err := json.Marshal(body.Config); err == nil {
			configJSON = string(encoded)
		}
	}
	req := &channelspb.CreateChannelRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Name:        strings.TrimSpace(body.Name),
		Type:        strings.TrimSpace(body.Type),
		ConfigJson:  configJSON,
		UserContext: h.userCtx(r),
	}
	resp, err := h.clients.Channels.CreateChannel(r.Context(), req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, channelMap(resp))
}

func (h *ChannelsHandler) GetChannel(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Channels.GetChannel(r.Context(), &channelspb.ChannelRequest{
		ChannelId: chi.URLParam(r, "channelId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, channelMap(resp))
}

func (h *ChannelsHandler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string         `json:"name"`
		Status     string         `json:"status"`
		Config     map[string]any `json:"config"`
		ConfigJSON string         `json:"configJson"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	configJSON := strings.TrimSpace(body.ConfigJSON)
	if configJSON == "" && body.Config != nil {
		if encoded, err := json.Marshal(body.Config); err == nil {
			configJSON = string(encoded)
		}
	}
	req := &channelspb.UpdateChannelRequest{
		ChannelId:   chi.URLParam(r, "channelId"),
		Name:        strings.TrimSpace(body.Name),
		Status:      strings.TrimSpace(body.Status),
		ConfigJson:  configJSON,
		UserContext: h.userCtx(r),
	}
	resp, err := h.clients.Channels.UpdateChannel(r.Context(), req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, channelMap(resp))
}

func (h *ChannelsHandler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Channels.DeleteChannel(r.Context(), &channelspb.ChannelRequest{
		ChannelId: chi.URLParam(r, "channelId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ChannelsHandler) ListRoutingRules(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Channels.ListRoutingRules(r.Context(), &channelspb.ChannelRequest{
		ChannelId: chi.URLParam(r, "channelId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Rules)
}

func (h *ChannelsHandler) CreateRoutingRule(w http.ResponseWriter, r *http.Request) {
	var body channelspb.CreateRoutingRuleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.ChannelId = chi.URLParam(r, "channelId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Channels.CreateRoutingRule(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, resp)
}

func (h *ChannelsHandler) UpdateRoutingRule(w http.ResponseWriter, r *http.Request) {
	var body channelspb.UpdateRoutingRuleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.RuleId = chi.URLParam(r, "ruleId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Channels.UpdateRoutingRule(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (h *ChannelsHandler) DeleteRoutingRule(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Channels.DeleteRoutingRule(r.Context(), &channelspb.RuleRequest{
		RuleId: chi.URLParam(r, "ruleId"), ChannelId: chi.URLParam(r, "channelId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleWebhook — public endpoint, no JWT auth required
func (h *ChannelsHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	// Limit webhook body to 1MB
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	channelID := chi.URLParam(r, "channelId")
	if channelID == "" || len(channelID) > 64 {
		writeError(w, http.StatusBadRequest, "invalid channel ID")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	headers := make(map[string]string)
	for k, v := range r.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}
	resp, err := h.clients.Channels.HandleWebhook(r.Context(), &channelspb.WebhookRequest{
		ChannelId: channelID,
		Body:      string(body),
		Headers:   headers,
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	if !resp.Accepted {
		writeError(w, http.StatusUnauthorized, resp.Message)
		return
	}
	// Return challenge string for platform URL verification handshakes
	if resp.Challenge != "" {
		writeJSON(w, http.StatusOK, map[string]string{"challenge": resp.Challenge})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *ChannelsHandler) ListChannelMessages(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Channels.ListChannelMessages(r.Context(), &channelspb.ListChannelMessagesRequest{
		ChannelId: chi.URLParam(r, "channelId"), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Messages)
}

func (h *ChannelsHandler) TestConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type   string            `json:"type"`
		Config map[string]string `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	configBytes, _ := json.Marshal(body.Config)
	resp, err := h.clients.Channels.TestConnection(r.Context(), &channelspb.TestConnectionRequest{
		Type: body.Type, ConfigJson: string(configBytes), UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, map[string]any{
		"success": resp.Success,
		"botName": resp.BotName,
		"error":   resp.Error,
	})
}

func (h *ChannelsHandler) SendChannelMessage(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Runtime-Secret") != h.runtimeSecret {
		writeError(w, http.StatusUnauthorized, "invalid runtime secret")
		return
	}
	var req struct {
		ChatId   string `json:"chatId"`
		Text     string `json:"text"`
		ThreadId string `json:"threadId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body := channelspb.SendChannelMessageRequest{
		ChannelId:   chi.URLParam(r, "channelId"),
		ChatId:      req.ChatId,
		Text:        req.Text,
		ThreadId:    req.ThreadId,
		UserContext: h.userCtx(r),
	}
	_, err := h.clients.Channels.SendChannelMessage(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
