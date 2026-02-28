package handler

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
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

const usageEstimatedCostPer1KTokens = 0.002

type usageQueryParams struct {
	startDate   string
	endDate     string
	workspaceID string
	agentID     string
	page        int
	pageSize    int
	format      string
}

type orgUsageView struct {
	id           string
	workspaceID  string
	timestamp    time.Time
	timestampRaw string
	day          string
	agentID      string
	agentName    string
	agentRole    string
	provider     string
	model        string
	inputTokens  int64
	outputTokens int64
	totalTokens  int64
	durationMs   int64
	cost         float64
	success      bool
}

func parseDateOnly(value string) (time.Time, bool) {
	t, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(value), time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func parseTimestamp(value string) (time.Time, bool) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return time.Time{}, false
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
	}
	for _, layout := range layouts {
		t, err := time.ParseInLocation(layout, raw, time.UTC)
		if err == nil {
			return t.UTC(), true
		}
	}
	if len(raw) >= 10 {
		if d, ok := parseDateOnly(raw[:10]); ok {
			return d, true
		}
	}
	return time.Time{}, false
}

func normalizeDateRange(startDateRaw, endDateRaw string) (string, string) {
	now := time.Now().UTC()
	defaultEnd := now.Format("2006-01-02")
	defaultStart := now.AddDate(0, 0, -29).Format("2006-01-02")

	startDate := strings.TrimSpace(startDateRaw)
	endDate := strings.TrimSpace(endDateRaw)
	if startDate == "" {
		startDate = defaultStart
	}
	if endDate == "" {
		endDate = defaultEnd
	}

	startAt, okStart := parseDateOnly(startDate)
	endAt, okEnd := parseDateOnly(endDate)
	if !okStart || !okEnd {
		return defaultStart, defaultEnd
	}
	if endAt.Before(startAt) {
		startAt, endAt = endAt, startAt
	}
	if endAt.Sub(startAt).Hours()/24 > 180 {
		startAt = endAt.AddDate(0, 0, -180)
	}
	return startAt.Format("2006-01-02"), endAt.Format("2006-01-02")
}

func buildDateRangeKeys(startDate, endDate string) []string {
	startAt, okStart := parseDateOnly(startDate)
	endAt, okEnd := parseDateOnly(endDate)
	if !okStart || !okEnd || endAt.Before(startAt) {
		return buildRecentDateKeys(30)
	}

	out := make([]string, 0, int(endAt.Sub(startAt).Hours()/24)+1)
	for d := startAt; !d.After(endAt); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func calcTrend(current, previous float64) int {
	if previous == 0 {
		if current > 0 {
			return 100
		}
		return 0
	}
	return int(math.Round(((current - previous) / previous) * 100))
}

func roundFloat(value float64, digits int) float64 {
	pow := math.Pow10(max(0, digits))
	return math.Round(value*pow) / pow
}

func sumFloat64(values []float64) float64 {
	total := 0.0
	for _, v := range values {
		total += v
	}
	return total
}

func sparklineFromSeries(values []float64, width int) []float64 {
	safeWidth := max(1, width)
	if len(values) >= safeWidth {
		out := make([]float64, safeWidth)
		copy(out, values[len(values)-safeWidth:])
		return out
	}
	out := make([]float64, safeWidth)
	copy(out[safeWidth-len(values):], values)
	return out
}

func computeDurationMs(startedAt, endedAt string) int64 {
	startTime, okStart := parseTimestamp(startedAt)
	endTime, okEnd := parseTimestamp(endedAt)
	if !okStart || !okEnd {
		return 0
	}
	if endTime.Before(startTime) {
		return 0
	}
	return endTime.Sub(startTime).Milliseconds()
}

func parseUsageQueryParams(r *http.Request) usageQueryParams {
	startDate, endDate := normalizeDateRange(
		r.URL.Query().Get("startDate"),
		r.URL.Query().Get("endDate"),
	)

	page := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			page = n
		}
	}

	pageSize := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("pageSize")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			pageSize = min(500, n)
		}
	}

	return usageQueryParams{
		startDate:   startDate,
		endDate:     endDate,
		workspaceID: strings.TrimSpace(r.URL.Query().Get("workspaceId")),
		agentID:     strings.TrimSpace(r.URL.Query().Get("agentId")),
		page:        page,
		pageSize:    pageSize,
		format:      strings.TrimSpace(strings.ToLower(r.URL.Query().Get("format"))),
	}
}

func toUsageView(item *chatpb.UsageRecord) orgUsageView {
	timestampRaw := strings.TrimSpace(item.EndedAt)
	if timestampRaw == "" {
		timestampRaw = strings.TrimSpace(item.RecordedAt)
	}
	if timestampRaw == "" {
		timestampRaw = strings.TrimSpace(item.StartedAt)
	}

	timestamp, ok := parseTimestamp(timestampRaw)
	if !ok {
		timestamp = time.Now().UTC()
	}
	day := timestamp.Format("2006-01-02")

	provider := strings.TrimSpace(item.ProviderName)
	if provider == "" {
		provider = strings.TrimSpace(item.ProviderId)
	}
	if provider == "" {
		provider = "Unknown"
	}

	model := strings.TrimSpace(item.ModelName)
	if model == "" {
		model = strings.TrimSpace(item.ModelId)
	}
	if model == "" {
		model = "Unknown"
	}

	agentName := strings.TrimSpace(item.AgentName)
	if agentName == "" {
		agentName = "Unknown Agent"
	}
	agentRole := strings.TrimSpace(item.AgentRole)
	if agentRole == "" {
		agentRole = "coordinator"
	}

	status := strings.ToLower(strings.TrimSpace(item.Status))
	success := status == "completed" || (item.FailureCount == 0 && item.SuccessCount > 0)
	durationMs := computeDurationMs(item.StartedAt, item.EndedAt)
	totalTokens := int64(item.TotalTokens)
	cost := roundFloat((float64(totalTokens)/1000.0)*usageEstimatedCostPer1KTokens, 4)

	return orgUsageView{
		id:           item.Id,
		workspaceID:  item.WorkspaceId,
		timestamp:    timestamp,
		timestampRaw: timestampRaw,
		day:          day,
		agentID:      strings.TrimSpace(item.AgentId),
		agentName:    agentName,
		agentRole:    agentRole,
		provider:     provider,
		model:        model,
		inputTokens:  int64(item.InputTokens),
		outputTokens: int64(item.OutputTokens),
		totalTokens:  totalTokens,
		durationMs:   durationMs,
		cost:         cost,
		success:      success,
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

func (h *OrgHandler) listOrgUsageViews(
	r *http.Request,
	orgSlug string,
	params usageQueryParams,
) ([]orgUsageView, bool, error) {
	workspaceResp, err := h.clients.Org.ListWorkspaces(r.Context(), &orgpb.ListWorkspacesRequest{
		OrgId:       orgSlug,
		UserContext: h.userCtx(r),
	})
	if err != nil {
		return nil, false, err
	}

	workspaceIDs := make([]string, 0, len(workspaceResp.Workspaces))
	workspaceSet := map[string]struct{}{}
	for _, ws := range workspaceResp.Workspaces {
		id := strings.TrimSpace(ws.Id)
		if id == "" {
			continue
		}
		workspaceIDs = append(workspaceIDs, id)
		workspaceSet[id] = struct{}{}
	}

	if params.workspaceID != "" {
		if _, ok := workspaceSet[params.workspaceID]; !ok {
			return nil, false, nil
		}
		workspaceIDs = []string{params.workspaceID}
	}

	userCtx := h.userCtx(r)
	rawRecords := make([]*chatpb.UsageRecord, 0, 256)
	for _, workspaceID := range workspaceIDs {
		var offset int32
		for {
			resp, listErr := h.clients.Chat.ListUsageRecords(r.Context(), &chatpb.ListUsageRecordsRequest{
				WorkspaceId: workspaceID,
				Limit:       2000,
				Offset:      offset,
				StartDate:   params.startDate,
				EndDate:     params.endDate,
				UserContext: userCtx,
			})
			if listErr != nil {
				return nil, false, listErr
			}

			if resp == nil || len(resp.Records) == 0 {
				break
			}
			rawRecords = append(rawRecords, resp.Records...)
			offset += int32(len(resp.Records))
			if offset >= resp.Total {
				break
			}
		}
	}

	views := make([]orgUsageView, 0, len(rawRecords))
	for _, item := range rawRecords {
		view := toUsageView(item)
		if params.agentID != "" && view.agentID != params.agentID {
			continue
		}
		views = append(views, view)
	}

	sort.Slice(views, func(i, j int) bool {
		return views[i].timestamp.After(views[j].timestamp)
	})
	return views, true, nil
}

func (h *OrgHandler) GetUsageOverview(w http.ResponseWriter, r *http.Request) {
	params := parseUsageQueryParams(r)
	orgRef := chi.URLParam(r, "orgId")
	_, orgSlug := h.resolveOrgIdentity(r, orgRef)

	views, matchedWorkspace, err := h.listOrgUsageViews(r, orgSlug, params)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	if !matchedWorkspace {
		writeError(w, http.StatusBadRequest, "workspaceId does not belong to organization")
		return
	}

	dateKeys := buildDateRangeKeys(params.startDate, params.endDate)
	type dayBucket struct {
		tokenSum    float64
		callCount   float64
		durationSum float64
	}
	daily := map[string]*dayBucket{}
	for _, d := range dateKeys {
		daily[d] = &dayBucket{}
	}

	totalDuration := float64(0)
	totalCalls := float64(0)
	for _, item := range views {
		b, ok := daily[item.day]
		if !ok {
			continue
		}
		b.tokenSum += float64(item.totalTokens)
		b.callCount += 1
		b.durationSum += float64(item.durationMs)
		totalDuration += float64(item.durationMs)
		totalCalls += 1
	}

	tokenSeries := make([]float64, 0, len(dateKeys))
	callSeries := make([]float64, 0, len(dateKeys))
	avgRespSeries := make([]float64, 0, len(dateKeys))
	costSeries := make([]float64, 0, len(dateKeys))
	for _, d := range dateKeys {
		b := daily[d]
		tokenSeries = append(tokenSeries, b.tokenSum)
		callSeries = append(callSeries, b.callCount)
		if b.callCount > 0 {
			avgRespSeries = append(avgRespSeries, b.durationSum/b.callCount)
		} else {
			avgRespSeries = append(avgRespSeries, 0)
		}
		costSeries = append(costSeries, roundFloat((b.tokenSum/1000.0)*usageEstimatedCostPer1KTokens, 4))
	}

	split := len(dateKeys) / 2
	if split < 1 {
		split = 1
	}

	tokenValue := sumFloat64(tokenSeries)
	callValue := sumFloat64(callSeries)
	costValue := sumFloat64(costSeries)
	avgRespValue := float64(0)
	if totalCalls > 0 {
		avgRespValue = totalDuration / totalCalls
	}

	tokenTrend := calcTrend(sumFloat64(tokenSeries[split:]), sumFloat64(tokenSeries[:split]))
	callTrend := calcTrend(sumFloat64(callSeries[split:]), sumFloat64(callSeries[:split]))
	costTrend := calcTrend(sumFloat64(costSeries[split:]), sumFloat64(costSeries[:split]))
	avgRespTrend := calcTrend(sumFloat64(avgRespSeries[split:]), sumFloat64(avgRespSeries[:split]))

	writeData(w, http.StatusOK, map[string]any{
		"totalTokens": map[string]any{
			"value":     int64(math.Round(tokenValue)),
			"trend":     tokenTrend,
			"sparkline": sparklineFromSeries(tokenSeries, 7),
		},
		"apiCalls": map[string]any{
			"value":     int64(math.Round(callValue)),
			"trend":     callTrend,
			"sparkline": sparklineFromSeries(callSeries, 7),
		},
		"avgResponseTime": map[string]any{
			"value":     int64(math.Round(avgRespValue)),
			"trend":     avgRespTrend,
			"sparkline": sparklineFromSeries(avgRespSeries, 7),
		},
		"estimatedCost": map[string]any{
			"value":     roundFloat(costValue, 4),
			"trend":     costTrend,
			"sparkline": sparklineFromSeries(costSeries, 7),
		},
	})
}

func (h *OrgHandler) GetUsageTokenTrend(w http.ResponseWriter, r *http.Request) {
	params := parseUsageQueryParams(r)
	orgRef := chi.URLParam(r, "orgId")
	_, orgSlug := h.resolveOrgIdentity(r, orgRef)

	views, matchedWorkspace, err := h.listOrgUsageViews(r, orgSlug, params)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	if !matchedWorkspace {
		writeError(w, http.StatusBadRequest, "workspaceId does not belong to organization")
		return
	}

	dateKeys := buildDateRangeKeys(params.startDate, params.endDate)
	type tokenBucket struct {
		input  int64
		output int64
	}
	daily := map[string]*tokenBucket{}
	for _, d := range dateKeys {
		daily[d] = &tokenBucket{}
	}
	for _, item := range views {
		if b, ok := daily[item.day]; ok {
			b.input += item.inputTokens
			b.output += item.outputTokens
		}
	}

	out := make([]map[string]any, 0, len(dateKeys))
	for _, d := range dateKeys {
		b := daily[d]
		out = append(out, map[string]any{
			"date":         d,
			"inputTokens":  b.input,
			"outputTokens": b.output,
		})
	}
	writeData(w, http.StatusOK, out)
}

func (h *OrgHandler) GetUsageProviders(w http.ResponseWriter, r *http.Request) {
	params := parseUsageQueryParams(r)
	orgRef := chi.URLParam(r, "orgId")
	_, orgSlug := h.resolveOrgIdentity(r, orgRef)

	views, matchedWorkspace, err := h.listOrgUsageViews(r, orgSlug, params)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	if !matchedWorkspace {
		writeError(w, http.StatusBadRequest, "workspaceId does not belong to organization")
		return
	}

	type providerUsage struct {
		name   string
		tokens int64
	}
	providerTotals := map[string]*providerUsage{}
	var grandTotal int64
	for _, item := range views {
		p := item.provider
		entry, ok := providerTotals[p]
		if !ok {
			entry = &providerUsage{name: p}
			providerTotals[p] = entry
		}
		entry.tokens += item.totalTokens
		grandTotal += item.totalTokens
	}

	list := make([]*providerUsage, 0, len(providerTotals))
	for _, item := range providerTotals {
		list = append(list, item)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].tokens > list[j].tokens
	})

	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		percentage := 0
		if grandTotal > 0 {
			percentage = int(math.Round(float64(item.tokens) * 100.0 / float64(grandTotal)))
		}
		out = append(out, map[string]any{
			"provider":   item.name,
			"tokens":     item.tokens,
			"percentage": percentage,
			"color":      providerColor(item.name, ""),
		})
	}
	writeData(w, http.StatusOK, out)
}

func (h *OrgHandler) GetUsageAgentRanking(w http.ResponseWriter, r *http.Request) {
	params := parseUsageQueryParams(r)
	orgRef := chi.URLParam(r, "orgId")
	_, orgSlug := h.resolveOrgIdentity(r, orgRef)

	views, matchedWorkspace, err := h.listOrgUsageViews(r, orgSlug, params)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	if !matchedWorkspace {
		writeError(w, http.StatusBadRequest, "workspaceId does not belong to organization")
		return
	}

	type agentUsage struct {
		id    string
		name  string
		role  string
		token int64
	}
	agentTotals := map[string]*agentUsage{}
	for _, item := range views {
		id := item.agentID
		if id == "" {
			id = "unknown"
		}
		entry, ok := agentTotals[id]
		if !ok {
			entry = &agentUsage{
				id:    id,
				name:  item.agentName,
				role:  item.agentRole,
				token: 0,
			}
			agentTotals[id] = entry
		}
		entry.token += item.totalTokens
	}

	list := make([]*agentUsage, 0, len(agentTotals))
	for _, item := range agentTotals {
		list = append(list, item)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].token > list[j].token
	})

	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		out = append(out, map[string]any{
			"agentId":   item.id,
			"agentName": item.name,
			"role":      item.role,
			"tokens":    item.token,
		})
	}
	writeData(w, http.StatusOK, out)
}

func (h *OrgHandler) ListUsageRecords(w http.ResponseWriter, r *http.Request) {
	params := parseUsageQueryParams(r)
	orgRef := chi.URLParam(r, "orgId")
	_, orgSlug := h.resolveOrgIdentity(r, orgRef)

	views, matchedWorkspace, err := h.listOrgUsageViews(r, orgSlug, params)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	if !matchedWorkspace {
		writeError(w, http.StatusBadRequest, "workspaceId does not belong to organization")
		return
	}

	if params.format == "csv" {
		fileName := fmt.Sprintf(
			"org-usage-records-%s-%s.csv",
			orgSlug,
			time.Now().UTC().Format("20060102-150405"),
		)
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", fileName))
		w.WriteHeader(http.StatusOK)

		writer := csv.NewWriter(w)
		_ = writer.Write([]string{
			"id", "timestamp", "workspaceId", "agentId", "agentName", "agentRole",
			"provider", "model", "inputTokens", "outputTokens", "durationMs", "cost", "success",
		})
		for _, item := range views {
			_ = writer.Write([]string{
				item.id,
				item.timestamp.UTC().Format(time.RFC3339),
				item.workspaceID,
				item.agentID,
				item.agentName,
				item.agentRole,
				item.provider,
				item.model,
				strconv.FormatInt(item.inputTokens, 10),
				strconv.FormatInt(item.outputTokens, 10),
				strconv.FormatInt(item.durationMs, 10),
				strconv.FormatFloat(item.cost, 'f', 4, 64),
				strconv.FormatBool(item.success),
			})
		}
		writer.Flush()
		return
	}

	total := len(views)
	page := max(1, params.page)
	pageSize := max(1, params.pageSize)
	totalPages := int(math.Ceil(float64(total) / float64(pageSize)))
	if total == 0 {
		totalPages = 0
	}
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := min(total, start+pageSize)

	rows := make([]map[string]any, 0, end-start)
	for _, item := range views[start:end] {
		rows = append(rows, map[string]any{
			"id":           item.id,
			"timestamp":    item.timestamp.UTC().Format(time.RFC3339),
			"agentId":      item.agentID,
			"agentName":    item.agentName,
			"agentRole":    item.agentRole,
			"provider":     item.provider,
			"model":        item.model,
			"inputTokens":  item.inputTokens,
			"outputTokens": item.outputTokens,
			"duration":     item.durationMs,
			"cost":         item.cost,
			"success":      item.success,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":       rows,
		"total":      total,
		"page":       page,
		"pageSize":   pageSize,
		"totalPages": totalPages,
	})
}
