package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	orgpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/org"
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

func (h *OrgHandler) ListOrgs(w http.ResponseWriter, r *http.Request) {
	u, _ := middleware.GetUser(r)
	resp, err := h.clients.Org.ListOrgs(r.Context(), &orgpb.ListOrgsRequest{
		UserContext: &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name},
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Orgs)
}

func (h *OrgHandler) GetOrg(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	resp, err := h.clients.Org.GetOrg(r.Context(), &orgpb.GetOrgRequest{
		Slug: slug, UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp)
}

func (h *OrgHandler) UpdateOrg(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var body orgpb.UpdateOrgRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.Slug = slug
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Org.UpdateOrg(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp)
}

func (h *OrgHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	resp, err := h.clients.Org.ListMembers(r.Context(), &orgpb.ListMembersRequest{
		OrgId: orgID, UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Members)
}

func (h *OrgHandler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	resp, err := h.clients.Org.ListWorkspaces(r.Context(), &orgpb.ListWorkspacesRequest{
		OrgId: orgID, UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Workspaces)
}

func (h *OrgHandler) GetDashboardStats(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	resp, err := h.clients.Org.GetDashboardStats(r.Context(), &orgpb.GetDashboardStatsRequest{
		OrgId: orgID, UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }

	metric := func(m *orgpb.StatMetric) map[string]any {
		if m == nil { return map[string]any{"value": 0, "trend": 0.0, "sparkline": []int{0,0,0,0,0,0,0}} }
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
