package handler

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

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

func normalizeJSONObject(raw json.RawMessage, fieldName string) (string, error) {
	if len(raw) == 0 {
		return "", fmt.Errorf("%s must be a JSON object", fieldName)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", fmt.Errorf("%s must be valid JSON object", fieldName)
	}
	normalized, err := json.Marshal(obj)
	if err != nil {
		return "", fmt.Errorf("%s must be valid JSON object", fieldName)
	}
	return string(normalized), nil
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

func (h *ChatHandler) UpdateUserMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	resp, err := h.clients.Chat.UpdateUserMessage(r.Context(), &chatpb.UpdateUserMessageRequest{
		SessionId:   chi.URLParam(r, "sessionId"),
		MessageId:   chi.URLParam(r, "messageId"),
		Content:     body.Content,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	writeData(w, http.StatusOK, map[string]any{
		"message":           messageMap(resp.Message),
		"removedMessageIds": resp.RemovedMessageIds,
	})
}

func (h *ChatHandler) GetRuntimeMetrics(w http.ResponseWriter, r *http.Request) {
	days := int32(7)
	if raw := r.URL.Query().Get("days"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 90 {
			days = int32(n)
		}
	}

	resp, err := h.clients.Chat.GetRuntimeMetrics(r.Context(), &chatpb.GetRuntimeMetricsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Days:        days,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	daily := make([]map[string]any, len(resp.Daily))
	for i, item := range resp.Daily {
		daily[i] = map[string]any{
			"date":            item.Date,
			"inputTokens":     item.InputTokens,
			"outputTokens":    item.OutputTokens,
			"totalTokens":     item.TotalTokens,
			"successfulRuns":  item.SuccessfulRuns,
			"failedRuns":      item.FailedRuns,
			"successfulTasks": item.SuccessfulTasks,
			"failedTasks":     item.FailedTasks,
		}
	}

	agents := make([]map[string]any, len(resp.Agents))
	for i, item := range resp.Agents {
		agents[i] = map[string]any{
			"agentId":         item.AgentId,
			"name":            item.Name,
			"role":            item.Role,
			"inputTokens":     item.InputTokens,
			"outputTokens":    item.OutputTokens,
			"totalTokens":     item.TotalTokens,
			"successfulRuns":  item.SuccessfulRuns,
			"failedRuns":      item.FailedRuns,
			"successfulTasks": item.SuccessfulTasks,
			"failedTasks":     item.FailedTasks,
		}
	}

	writeData(w, http.StatusOK, map[string]any{
		"totalInputTokens":        resp.TotalInputTokens,
		"totalOutputTokens":       resp.TotalOutputTokens,
		"totalTokens":             resp.TotalTokens,
		"coordinatorInputTokens":  resp.CoordinatorInputTokens,
		"coordinatorOutputTokens": resp.CoordinatorOutputTokens,
		"coordinatorTotalTokens":  resp.CoordinatorTotalTokens,
		"subAgentInputTokens":     resp.SubAgentInputTokens,
		"subAgentOutputTokens":    resp.SubAgentOutputTokens,
		"subAgentTotalTokens":     resp.SubAgentTotalTokens,
		"successfulRuns":          resp.SuccessfulRuns,
		"failedRuns":              resp.FailedRuns,
		"successfulTasks":         resp.SuccessfulTasks,
		"failedTasks":             resp.FailedTasks,
		"daily":                   daily,
		"agents":                  agents,
	})
}

func (h *ChatHandler) ListUsageRecords(w http.ResponseWriter, r *http.Request) {
	limit := int32(200)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 2000 {
			limit = int32(n)
		}
	}

	offset := int32(0)
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
			offset = int32(n)
		}
	}

	resp, err := h.clients.Chat.ListUsageRecords(r.Context(), &chatpb.ListUsageRecordsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Limit:       limit,
		Offset:      offset,
		StartDate:   r.URL.Query().Get("startDate"),
		EndDate:     r.URL.Query().Get("endDate"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	format := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("format")))
	if isPluginJSONFormat(format) || isPluginNDJSONFormat(format) {
		events := make([]map[string]any, 0, len(resp.Records))
		for _, item := range resp.Records {
			events = append(events, buildPluginUsageEvent(pluginUsageSourceRecord{
				ID:           item.Id,
				WorkspaceID:  item.WorkspaceId,
				OrgID:        item.OrgId,
				SessionID:    item.SessionId,
				RunID:        item.RunId,
				TaskID:       item.TaskId,
				RecordType:   item.RecordType,
				Scope:        item.Scope,
				Status:       item.Status,
				AgentID:      item.AgentId,
				AgentName:    item.AgentName,
				AgentRole:    item.AgentRole,
				Provider:     item.ProviderName,
				Model:        item.ModelName,
				InputTokens:  int64(item.InputTokens),
				OutputTokens: int64(item.OutputTokens),
				TotalTokens:  int64(item.TotalTokens),
				SuccessCount: int64(item.SuccessCount),
				FailureCount: int64(item.FailureCount),
				DurationMs:   computeDurationMs(item.StartedAt, item.EndedAt),
				Timestamp:    item.RecordedAt,
				MetadataJSON: item.MetadataJson,
			}))
		}

		if isPluginNDJSONFormat(format) {
			fileName := fmt.Sprintf(
				"plugin-usage-events-%s-%s.ndjson",
				chi.URLParam(r, "wsId"),
				time.Now().UTC().Format("20060102-150405"),
			)
			w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", fileName))
			w.WriteHeader(http.StatusOK)
			encoder := json.NewEncoder(w)
			for _, event := range events {
				if err := encoder.Encode(event); err != nil {
					return
				}
			}
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"specVersion":     pluginUsageSpecVersion,
			"records":         events,
			"total":           resp.Total,
			"sumInputTokens":  resp.SumInputTokens,
			"sumOutputTokens": resp.SumOutputTokens,
			"sumTotalTokens":  resp.SumTotalTokens,
			"sumSuccessCount": resp.SumSuccessCount,
			"sumFailureCount": resp.SumFailureCount,
		})
		return
	}

	if format == "csv" {
		fileName := fmt.Sprintf(
			"usage-records-%s-%s.csv",
			chi.URLParam(r, "wsId"),
			time.Now().UTC().Format("20060102-150405"),
		)
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", fileName))
		w.WriteHeader(http.StatusOK)

		writer := csv.NewWriter(w)
		_ = writer.Write([]string{
			"id", "workspaceId", "orgId", "sessionId", "runId", "taskId",
			"recordType", "scope", "status",
			"agentId", "agentName", "agentRole",
			"providerId", "providerName", "modelId", "modelName",
			"inputTokens", "outputTokens", "totalTokens",
			"successCount", "failureCount",
			"startedAt", "endedAt", "recordedAt", "metadataJson",
		})

		for _, item := range resp.Records {
			_ = writer.Write([]string{
				item.Id,
				item.WorkspaceId,
				item.OrgId,
				item.SessionId,
				item.RunId,
				item.TaskId,
				item.RecordType,
				item.Scope,
				item.Status,
				item.AgentId,
				item.AgentName,
				item.AgentRole,
				item.ProviderId,
				item.ProviderName,
				item.ModelId,
				item.ModelName,
				strconv.Itoa(int(item.InputTokens)),
				strconv.Itoa(int(item.OutputTokens)),
				strconv.Itoa(int(item.TotalTokens)),
				strconv.Itoa(int(item.SuccessCount)),
				strconv.Itoa(int(item.FailureCount)),
				item.StartedAt,
				item.EndedAt,
				item.RecordedAt,
				item.MetadataJson,
			})
		}
		writer.Flush()
		return
	}

	records := make([]map[string]any, len(resp.Records))
	for i, item := range resp.Records {
		records[i] = map[string]any{
			"id":           item.Id,
			"workspaceId":  item.WorkspaceId,
			"orgId":        item.OrgId,
			"sessionId":    item.SessionId,
			"runId":        item.RunId,
			"taskId":       item.TaskId,
			"recordType":   item.RecordType,
			"scope":        item.Scope,
			"status":       item.Status,
			"agentId":      item.AgentId,
			"agentName":    item.AgentName,
			"agentRole":    item.AgentRole,
			"providerId":   item.ProviderId,
			"providerName": item.ProviderName,
			"modelId":      item.ModelId,
			"modelName":    item.ModelName,
			"inputTokens":  item.InputTokens,
			"outputTokens": item.OutputTokens,
			"totalTokens":  item.TotalTokens,
			"successCount": item.SuccessCount,
			"failureCount": item.FailureCount,
			"startedAt":    item.StartedAt,
			"endedAt":      item.EndedAt,
			"recordedAt":   item.RecordedAt,
			"metadataJson": item.MetadataJson,
		}
	}

	writeData(w, http.StatusOK, map[string]any{
		"records":         records,
		"total":           resp.Total,
		"sumInputTokens":  resp.SumInputTokens,
		"sumOutputTokens": resp.SumOutputTokens,
		"sumTotalTokens":  resp.SumTotalTokens,
		"sumSuccessCount": resp.SumSuccessCount,
		"sumFailureCount": resp.SumFailureCount,
	})
}

func (h *ChatHandler) ReportPluginUsageEvents(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(chi.URLParam(r, "wsId"))
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}

	var body struct {
		Events []struct {
			SpecVersion   string          `json:"specVersion"`
			PluginName    string          `json:"pluginName"`
			PluginVersion string          `json:"pluginVersion"`
			EventID       string          `json:"eventId"`
			EventType     string          `json:"eventType"`
			Timestamp     string          `json:"timestamp"`
			WorkspaceID   string          `json:"workspaceId"`
			RunID         string          `json:"runId"`
			Status        string          `json:"status"`
			Metrics       json.RawMessage `json:"metrics"`
			Payload       json.RawMessage `json:"payload"`
		} `json:"events"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(body.Events) == 0 {
		writeError(w, http.StatusBadRequest, "events is required")
		return
	}
	if len(body.Events) > 1000 {
		writeError(w, http.StatusBadRequest, "events exceeds limit (max 1000)")
		return
	}

	allowedStatus := map[string]struct{}{"success": {}, "failure": {}, "partial": {}}
	events := make([]*chatpb.PluginUsageEvent, 0, len(body.Events))
	for idx, item := range body.Events {
		prefix := fmt.Sprintf("events[%d]", idx)
		specVersion := strings.TrimSpace(item.SpecVersion)
		pluginName := strings.TrimSpace(item.PluginName)
		pluginVersion := strings.TrimSpace(item.PluginVersion)
		eventID := strings.TrimSpace(item.EventID)
		eventType := strings.TrimSpace(item.EventType)
		timestamp := strings.TrimSpace(item.Timestamp)
		eventWorkspaceID := strings.TrimSpace(item.WorkspaceID)
		status := strings.ToLower(strings.TrimSpace(item.Status))

		if specVersion != pluginUsageSpecVersion {
			writeError(w, http.StatusBadRequest, prefix+".specVersion must be plugin-usage.v1")
			return
		}
		if pluginName == "" || pluginVersion == "" || eventID == "" || eventType == "" || eventWorkspaceID == "" {
			writeError(w, http.StatusBadRequest, prefix+" missing required fields")
			return
		}
		if eventWorkspaceID != workspaceID {
			writeError(w, http.StatusBadRequest, prefix+".workspaceId must match path workspace id")
			return
		}
		if _, ok := allowedStatus[status]; !ok {
			writeError(w, http.StatusBadRequest, prefix+".status must be success|failure|partial")
			return
		}
		if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
			writeError(w, http.StatusBadRequest, prefix+".timestamp must be RFC3339 datetime")
			return
		}

		metricsJSON, err := normalizeJSONObject(item.Metrics, prefix+".metrics")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		payloadJSON, err := normalizeJSONObject(item.Payload, prefix+".payload")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		events = append(events, &chatpb.PluginUsageEvent{
			SpecVersion:   specVersion,
			PluginName:    pluginName,
			PluginVersion: pluginVersion,
			EventId:       eventID,
			EventType:     eventType,
			Timestamp:     timestamp,
			WorkspaceId:   eventWorkspaceID,
			RunId:         strings.TrimSpace(item.RunID),
			Status:        status,
			MetricsJson:   metricsJSON,
			PayloadJson:   payloadJSON,
		})
	}

	resp, err := h.clients.Chat.ReportPluginUsageEvents(r.Context(), &chatpb.ReportPluginUsageEventsRequest{
		WorkspaceId: workspaceID,
		Events:      events,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	writeData(w, http.StatusCreated, map[string]any{
		"accepted": resp.Accepted,
	})
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
