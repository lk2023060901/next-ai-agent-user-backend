package handler

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	chatpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/chat"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	orgpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/org"
	settingspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/settings"
)

type OrgHandler struct {
	clients *grpcclient.Clients
}

func NewOrgHandler(clients *grpcclient.Clients) *OrgHandler {
	return &OrgHandler{clients: clients}
}

func (h *OrgHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *OrgHandler) resolveOrgIdentity(r *http.Request, orgRef string) (orgID string, orgSlug string) {
	orgID = strings.TrimSpace(orgRef)
	orgSlug = strings.TrimSpace(orgRef)
	if orgSlug == "" {
		return orgID, orgSlug
	}

	resp, err := h.clients.Org.GetOrg(r.Context(), &orgpb.GetOrgRequest{
		Slug:        orgSlug,
		UserContext: h.userCtx(r),
	})
	if err != nil || resp == nil {
		return orgID, orgSlug
	}

	if strings.TrimSpace(resp.Id) != "" {
		orgID = resp.Id
	}
	if strings.TrimSpace(resp.Slug) != "" {
		orgSlug = resp.Slug
	}
	return orgID, orgSlug
}

func buildRecentDateKeys(days int) []string {
	safeDays := days
	if safeDays < 1 {
		safeDays = 1
	}
	if safeDays > 90 {
		safeDays = 90
	}

	now := time.Now().UTC()
	out := make([]string, 0, safeDays)
	for i := safeDays - 1; i >= 0; i-- {
		d := now.AddDate(0, 0, -i)
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func providerColor(name string, providerType string) string {
	v := strings.ToLower(strings.TrimSpace(name) + " " + strings.TrimSpace(providerType))
	switch {
	case strings.Contains(v, "zhipu") || strings.Contains(v, "glm") || strings.Contains(v, "bigmodel"):
		return "#7c5cff"
	case strings.Contains(v, "qwen") || strings.Contains(v, "dashscope") || strings.Contains(v, "tongyi"):
		return "#ff6b3d"
	case strings.Contains(v, "openai"):
		return "#10a37f"
	case strings.Contains(v, "anthropic") || strings.Contains(v, "claude"):
		return "#d4a27f"
	case strings.Contains(v, "google") || strings.Contains(v, "gemini"):
		return "#4285f4"
	default:
		return "#6b7280"
	}
}

func (h *OrgHandler) ListOrgs(w http.ResponseWriter, r *http.Request) {
	u, _ := middleware.GetUser(r)
	resp, err := h.clients.Org.ListOrgs(r.Context(), &orgpb.ListOrgsRequest{
		UserContext: &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name},
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Orgs)
}

func (h *OrgHandler) GetOrg(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	resp, err := h.clients.Org.GetOrg(r.Context(), &orgpb.GetOrgRequest{
		Slug: slug, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (h *OrgHandler) UpdateOrg(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var body orgpb.UpdateOrgRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.Slug = slug
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Org.UpdateOrg(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (h *OrgHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "slug")
	resp, err := h.clients.Org.ListMembers(r.Context(), &orgpb.ListMembersRequest{
		OrgId: orgID, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Members)
}

func (h *OrgHandler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "slug")
	resp, err := h.clients.Org.ListWorkspaces(r.Context(), &orgpb.ListWorkspacesRequest{
		OrgId: orgID, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Workspaces)
}

func (h *OrgHandler) GetDashboardStats(w http.ResponseWriter, r *http.Request) {
	orgRef := chi.URLParam(r, "orgId")
	orgID, _ := h.resolveOrgIdentity(r, orgRef)
	resp, err := h.clients.Org.GetDashboardStats(r.Context(), &orgpb.GetDashboardStatsRequest{
		OrgId: orgID, UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	metric := func(m *orgpb.StatMetric) map[string]any {
		if m == nil {
			return map[string]any{"value": 0, "trend": 0.0, "sparkline": []int{0, 0, 0, 0, 0, 0, 0}}
		}
		sp := make([]int32, len(m.Sparkline))
		copy(sp, m.Sparkline)
		return map[string]any{"value": m.Value, "trend": m.Trend, "sparkline": sp}
	}

	writeData(w, http.StatusOK, map[string]any{
		"activeAgents":   metric(resp.ActiveAgents),
		"todaySessions":  metric(resp.TodaySessions),
		"tokenUsage":     metric(resp.TokenUsage),
		"completedTasks": metric(resp.CompletedTasks),
	})
}

func (h *OrgHandler) GetDashboardTokenStats(w http.ResponseWriter, r *http.Request) {
	orgRef := chi.URLParam(r, "orgId")
	_, orgSlug := h.resolveOrgIdentity(r, orgRef)

	workspaceResp, err := h.clients.Org.ListWorkspaces(r.Context(), &orgpb.ListWorkspacesRequest{
		OrgId:       orgSlug,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	dateKeys := buildRecentDateKeys(7)
	dateSet := make(map[string]struct{}, len(dateKeys))
	for _, d := range dateKeys {
		dateSet[d] = struct{}{}
	}

	type trendBucket struct {
		input  int64
		output int64
	}
	type agentIdentity struct {
		modelName    string
		providerName string
		providerType string
	}
	type providerMetric struct {
		name  string
		color string
		token int64
	}
	type modelMetric struct {
		name     string
		provider string
		color    string
		token    int64
	}

	daily := make(map[string]*trendBucket, len(dateKeys))
	for _, d := range dateKeys {
		daily[d] = &trendBucket{}
	}

	providerTotals := map[string]*providerMetric{}
	modelTotals := map[string]*modelMetric{}

	addProviderTokens := func(providerName, providerType string, tokens int64) {
		name := strings.TrimSpace(providerName)
		if name == "" {
			name = "Unknown"
		}
		tokens = max(0, tokens)

		item, ok := providerTotals[name]
		if !ok {
			item = &providerMetric{
				name:  name,
				color: providerColor(name, providerType),
			}
			providerTotals[name] = item
		}
		item.token += tokens
	}

	addModelTokens := func(providerName, providerType, modelName string, tokens int64) {
		name := strings.TrimSpace(modelName)
		if name == "" {
			name = "Unknown"
		}
		provider := strings.TrimSpace(providerName)
		if provider == "" {
			provider = "Unknown"
		}
		tokens = max(0, tokens)

		key := provider + "||" + name
		item, ok := modelTotals[key]
		if !ok {
			item = &modelMetric{
				name:     name,
				provider: provider,
				color:    providerColor(provider, providerType),
			}
			modelTotals[key] = item
		}
		item.token += tokens
	}

	for _, ws := range workspaceResp.Workspaces {
		workspaceID := strings.TrimSpace(ws.Id)
		if workspaceID == "" {
			continue
		}

		runtimeResp, runtimeErr := h.clients.Chat.GetRuntimeMetrics(r.Context(), &chatpb.GetRuntimeMetricsRequest{
			WorkspaceId: workspaceID,
			Days:        7,
			UserContext: h.userCtx(r),
		})
		if runtimeErr != nil || runtimeResp == nil {
			continue
		}

		for _, item := range runtimeResp.Daily {
			if _, ok := dateSet[item.Date]; !ok {
				continue
			}
			bucket := daily[item.Date]
			if bucket == nil {
				continue
			}
			bucket.input += int64(item.InputTokens)
			bucket.output += int64(item.OutputTokens)
		}

		agentsResp, _ := h.clients.Chat.ListAgents(r.Context(), &chatpb.ListAgentsRequest{
			WorkspaceId: workspaceID,
			UserContext: h.userCtx(r),
		})
		providersResp, _ := h.clients.Settings.ListProviders(r.Context(), &settingspb.WorkspaceRequest{
			WorkspaceId: workspaceID,
			UserContext: h.userCtx(r),
		})
		modelsResp, _ := h.clients.Settings.ListAllModels(r.Context(), &settingspb.WorkspaceRequest{
			WorkspaceId: workspaceID,
			UserContext: h.userCtx(r),
		})

		providerByID := map[string]*settingspb.Provider{}
		if providersResp != nil {
			for _, p := range providersResp.Providers {
				providerByID[p.Id] = p
			}
		}

		modelByID := map[string]*settingspb.Model{}
		if modelsResp != nil {
			for _, m := range modelsResp.Models {
				modelByID[m.Id] = m
			}
		}

		agentByID := map[string]agentIdentity{}
		if agentsResp != nil {
			for _, a := range agentsResp.Agents {
				modelName := strings.TrimSpace(a.Model)
				providerName := "Unknown"
				providerType := ""
				if m := modelByID[a.ModelId]; m != nil {
					if strings.TrimSpace(m.Name) != "" {
						modelName = m.Name
					}
					if p := providerByID[m.ProviderId]; p != nil {
						if strings.TrimSpace(p.Name) != "" {
							providerName = p.Name
						}
						providerType = p.Type
					}
				}
				agentByID[a.Id] = agentIdentity{
					modelName:    modelName,
					providerName: providerName,
					providerType: providerType,
				}
			}
		}

		var summedAgentTokens int64
		for _, am := range runtimeResp.Agents {
			tokens := int64(am.TotalTokens)
			if tokens <= 0 {
				continue
			}
			summedAgentTokens += tokens

			ref, ok := agentByID[am.AgentId]
			if !ok {
				ref = agentIdentity{
					modelName:    "Unknown",
					providerName: "Unknown",
				}
			}
			addProviderTokens(ref.providerName, ref.providerType, tokens)
			addModelTokens(ref.providerName, ref.providerType, ref.modelName, tokens)
		}

		missingTokens := int64(runtimeResp.TotalTokens) - summedAgentTokens
		if missingTokens > 0 {
			addProviderTokens("Unknown", "", missingTokens)
			addModelTokens("Unknown", "", "Unknown", missingTokens)
		}
	}

	trend := make([]map[string]any, 0, len(dateKeys))
	var trendTotalTokens int64
	for _, date := range dateKeys {
		b := daily[date]
		input := int64(0)
		output := int64(0)
		if b != nil {
			input = b.input
			output = b.output
		}
		total := input + output
		trendTotalTokens += total
		trend = append(trend, map[string]any{
			"date":         date,
			"inputTokens":  input,
			"outputTokens": output,
		})
	}

	var providerGrandTotal int64
	for _, p := range providerTotals {
		providerGrandTotal += p.token
	}
	if providerGrandTotal == 0 && trendTotalTokens > 0 {
		addProviderTokens("Unknown", "", trendTotalTokens)
		providerGrandTotal = trendTotalTokens
	}

	var modelGrandTotal int64
	for _, m := range modelTotals {
		modelGrandTotal += m.token
	}
	if modelGrandTotal == 0 && trendTotalTokens > 0 {
		addModelTokens("Unknown", "", "Unknown", trendTotalTokens)
		modelGrandTotal = trendTotalTokens
	}

	providerList := make([]*providerMetric, 0, len(providerTotals))
	for _, p := range providerTotals {
		providerList = append(providerList, p)
	}
	sort.Slice(providerList, func(i, j int) bool { return providerList[i].token > providerList[j].token })

	modelList := make([]*modelMetric, 0, len(modelTotals))
	for _, m := range modelTotals {
		modelList = append(modelList, m)
	}
	sort.Slice(modelList, func(i, j int) bool { return modelList[i].token > modelList[j].token })

	providers := make([]map[string]any, 0, len(providerList))
	for _, p := range providerList {
		percentage := 0
		if providerGrandTotal > 0 {
			percentage = int(math.Round(float64(p.token) * 100 / float64(providerGrandTotal)))
		}
		providers = append(providers, map[string]any{
			"provider":   p.name,
			"tokens":     p.token,
			"percentage": percentage,
			"color":      p.color,
		})
	}

	models := make([]map[string]any, 0, len(modelList))
	for _, m := range modelList {
		percentage := 0
		if modelGrandTotal > 0 {
			percentage = int(math.Round(float64(m.token) * 100 / float64(modelGrandTotal)))
		}
		models = append(models, map[string]any{
			"model":      m.name,
			"provider":   m.provider,
			"tokens":     m.token,
			"percentage": percentage,
			"color":      m.color,
		})
	}

	providerTrend := make([]map[string]any, 0, len(dateKeys))
	for _, date := range dateKeys {
		b := daily[date]
		dayTotal := int64(0)
		if b != nil {
			dayTotal = b.input + b.output
		}
		entry := map[string]any{"date": date}
		if providerGrandTotal > 0 && dayTotal > 0 {
			for _, p := range providerList {
				share := float64(p.token) / float64(providerGrandTotal)
				entry[p.name] = int64(math.Round(float64(dayTotal) * share))
			}
		}
		providerTrend = append(providerTrend, entry)
	}

	modelTrend := make([]map[string]any, 0, len(dateKeys))
	for _, date := range dateKeys {
		b := daily[date]
		dayTotal := int64(0)
		if b != nil {
			dayTotal = b.input + b.output
		}
		entry := map[string]any{"date": date}
		if modelGrandTotal > 0 && dayTotal > 0 {
			for _, m := range modelList {
				share := float64(m.token) / float64(modelGrandTotal)
				entry[m.name] = int64(math.Round(float64(dayTotal) * share))
			}
		}
		modelTrend = append(modelTrend, entry)
	}

	writeData(w, http.StatusOK, map[string]any{
		"providers":     providers,
		"models":        models,
		"trend":         trend,
		"providerTrend": providerTrend,
		"modelTrend":    modelTrend,
	})
}
