package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	chatpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/chat"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
)

type PluginHandler struct {
	clients *grpcclient.Clients
}

func NewPluginHandler(clients *grpcclient.Clients) *PluginHandler {
	return &PluginHandler{clients: clients}
}

func (h *PluginHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func normalizePluginJSONObject(raw json.RawMessage, fieldName string) (string, error) {
	if len(raw) == 0 {
		return "{}", nil
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

func parseDefaultValueJSON(raw string) any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	var out any
	if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
		return nil
	}
	switch out.(type) {
	case string, float64, bool:
		return out
	default:
		return nil
	}
}

func pluginConfigFieldMap(field *chatpb.PluginConfigField) map[string]any {
	options := make([]map[string]any, 0, len(field.Options))
	for _, option := range field.Options {
		options = append(options, map[string]any{
			"value": option.Value,
			"label": option.Label,
		})
	}

	out := map[string]any{
		"key":      field.Key,
		"label":    field.Label,
		"type":     field.Type,
		"required": field.Required,
		"options":  options,
	}
	if field.Placeholder != "" {
		out["placeholder"] = field.Placeholder
	}
	if field.Description != "" {
		out["description"] = field.Description
	}
	if parsed := parseDefaultValueJSON(field.DefaultValueJson); parsed != nil {
		out["default"] = parsed
	}
	return out
}

func pluginMap(item *chatpb.PluginItem) map[string]any {
	configSchema := make([]map[string]any, 0, len(item.ConfigSchema))
	for _, field := range item.ConfigSchema {
		configSchema = append(configSchema, pluginConfigFieldMap(field))
	}

	return map[string]any{
		"id":              item.Id,
		"name":            item.Name,
		"displayName":     item.DisplayName,
		"description":     item.Description,
		"longDescription": item.LongDescription,
		"author":          item.Author,
		"authorAvatar":    item.AuthorAvatar,
		"icon":            item.Icon,
		"type":            item.Type,
		"version":         item.Version,
		"pricingModel":    item.PricingModel,
		"price":           item.Price,
		"monthlyPrice":    item.MonthlyPrice,
		"trialDays":       item.TrialDays,
		"rating":          item.Rating,
		"reviewCount":     item.ReviewCount,
		"installCount":    item.InstallCount,
		"tags":            item.Tags,
		"permissions":     item.Permissions,
		"configSchema":    configSchema,
		"screenshots":     item.Screenshots,
		"publishedAt":     item.PublishedAt,
		"updatedAt":       item.UpdatedAt,
		"sourceType":      item.SourceType,
		"sourceSpec":      item.SourceSpec,
	}
}

func parseConfigMap(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
		return map[string]any{}
	}
	if out == nil {
		return map[string]any{}
	}
	return out
}

func installedPluginMap(item *chatpb.WorkspaceInstalledPlugin) map[string]any {
	return map[string]any{
		"id":          item.Id,
		"workspaceId": item.WorkspaceId,
		"pluginId":    item.PluginId,
		"plugin":      pluginMap(item.Plugin),
		"status":      item.Status,
		"config":      parseConfigMap(item.ConfigJson),
		"installedAt": item.InstalledAt,
		"installedBy": item.InstalledBy,
	}
}

func pluginReviewMap(item *chatpb.PluginReview) map[string]any {
	return map[string]any{
		"id":         item.Id,
		"pluginId":   item.PluginId,
		"authorName": item.AuthorName,
		"rating":     item.Rating,
		"content":    item.Content,
		"createdAt":  item.CreatedAt,
	}
}

func (h *PluginHandler) ListMarketplace(w http.ResponseWriter, r *http.Request) {
	page := int32(1)
	if raw := r.URL.Query().Get("page"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			page = int32(n)
		}
	}
	pageSize := int32(24)
	if raw := r.URL.Query().Get("pageSize"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			pageSize = int32(n)
		}
	}

	resp, err := h.clients.Chat.ListMarketplacePlugins(r.Context(), &chatpb.ListMarketplacePluginsRequest{
		Type:         r.URL.Query().Get("type"),
		PricingModel: r.URL.Query().Get("pricingModel"),
		Search:       r.URL.Query().Get("search"),
		Sort:         r.URL.Query().Get("sort"),
		Page:         page,
		PageSize:     pageSize,
		UserContext:  h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	plugins := make([]map[string]any, len(resp.Data))
	for i, item := range resp.Data {
		plugins[i] = pluginMap(item)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       plugins,
		"total":      resp.Total,
		"page":       resp.Page,
		"pageSize":   resp.PageSize,
		"totalPages": resp.TotalPages,
	})
}

func (h *PluginHandler) GetMarketplacePlugin(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.GetMarketplacePlugin(r.Context(), &chatpb.GetMarketplacePluginRequest{
		PluginId:    chi.URLParam(r, "pluginId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, pluginMap(resp))
}

func (h *PluginHandler) ListPluginReviews(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.ListPluginReviews(r.Context(), &chatpb.ListPluginReviewsRequest{
		PluginId:    chi.URLParam(r, "pluginId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	reviews := make([]map[string]any, len(resp.Reviews))
	for i, item := range resp.Reviews {
		reviews[i] = pluginReviewMap(item)
	}
	writeData(w, http.StatusOK, reviews)
}

func (h *PluginHandler) ListWorkspacePlugins(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Chat.ListWorkspacePlugins(r.Context(), &chatpb.ListWorkspacePluginsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	items := make([]map[string]any, len(resp.Plugins))
	for i, item := range resp.Plugins {
		items[i] = installedPluginMap(item)
	}
	writeData(w, http.StatusOK, items)
}

func (h *PluginHandler) InstallWorkspacePlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PluginID        string          `json:"pluginId"`
		Config          json.RawMessage `json:"config"`
		SourceType      string          `json:"sourceType"`
		SourceSpec      string          `json:"sourceSpec"`
		SourcePin       bool            `json:"sourcePin"`
		SourceIntegrity string          `json:"sourceIntegrity"`
		Source          *struct {
			Type      string `json:"type"`
			Spec      string `json:"spec"`
			Pin       bool   `json:"pin"`
			Integrity string `json:"integrity"`
		} `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	configJSON, err := normalizePluginJSONObject(body.Config, "config")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	sourceType := strings.TrimSpace(body.SourceType)
	sourceSpec := strings.TrimSpace(body.SourceSpec)
	sourceIntegrity := strings.TrimSpace(body.SourceIntegrity)
	sourcePin := body.SourcePin
	if body.Source != nil {
		if sourceType == "" {
			sourceType = strings.TrimSpace(body.Source.Type)
		}
		if sourceSpec == "" {
			sourceSpec = strings.TrimSpace(body.Source.Spec)
		}
		if sourceIntegrity == "" {
			sourceIntegrity = strings.TrimSpace(body.Source.Integrity)
		}
		sourcePin = sourcePin || body.Source.Pin
	}

	resp, grpcErr := h.clients.Chat.InstallWorkspacePlugin(r.Context(), &chatpb.InstallWorkspacePluginRequest{
		WorkspaceId:     chi.URLParam(r, "wsId"),
		PluginId:        strings.TrimSpace(body.PluginID),
		ConfigJson:      configJSON,
		SourceType:      sourceType,
		SourceSpec:      sourceSpec,
		SourceIntegrity: sourceIntegrity,
		SourcePin:       sourcePin,
		UserContext:     h.userCtx(r),
	})
	if grpcErr != nil {
		writeGRPCError(w, grpcErr)
		return
	}

	writeData(w, http.StatusCreated, installedPluginMap(resp))
}

func (h *PluginHandler) UninstallWorkspacePlugin(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Chat.UninstallWorkspacePlugin(r.Context(), &chatpb.UninstallWorkspacePluginRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		PluginId:    chi.URLParam(r, "pluginId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, nil)
}

func (h *PluginHandler) UpdateWorkspacePlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	resp, err := h.clients.Chat.UpdateWorkspacePlugin(r.Context(), &chatpb.UpdateWorkspacePluginRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		PluginId:    chi.URLParam(r, "pluginId"),
		Status:      strings.TrimSpace(body.Status),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	writeData(w, http.StatusOK, installedPluginMap(resp))
}

func (h *PluginHandler) UpdateWorkspacePluginConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Config json.RawMessage `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	configJSON, err := normalizePluginJSONObject(body.Config, "config")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp, grpcErr := h.clients.Chat.UpdateWorkspacePluginConfig(r.Context(), &chatpb.UpdateWorkspacePluginConfigRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		PluginId:    chi.URLParam(r, "pluginId"),
		ConfigJson:  configJSON,
		UserContext: h.userCtx(r),
	})
	if grpcErr != nil {
		writeGRPCError(w, grpcErr)
		return
	}

	writeData(w, http.StatusOK, installedPluginMap(resp))
}
