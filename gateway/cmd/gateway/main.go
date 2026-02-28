package main

import (
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/rs/cors"

	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/config"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/handler"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/stream"
)

func main() {
	cfg := config.Load()

	clients, err := grpcclient.New(cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("failed to connect to gRPC service: %v", err)
	}
	defer clients.Close()

	r := chi.NewRouter()

	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(cors.New(cors.Options{
		AllowedOrigins:   cfg.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Request-ID", "X-Runtime-Secret"},
		AllowCredentials: true,
	}).Handler)

	authHandler := handler.NewAuthHandler(clients)
	chatHandler := handler.NewChatHandler(clients)
	orgHandler := handler.NewOrgHandler(clients)
	wsHandler := handler.NewWorkspaceHandler(clients)
	settingsHandler := handler.NewSettingsHandler(clients)
	toolsHandler := handler.NewToolsHandler(clients)
	pluginHandler := handler.NewPluginHandler(clients)
	channelsHandler := handler.NewChannelsHandler(clients, cfg.RuntimeSecret)
	runtimeToolsHandler := handler.NewRuntimeToolsHandler(handler.RuntimeToolsHandlerOptions{
		RuntimeSecret:      cfg.RuntimeSecret,
		DefaultProvider:    cfg.WebSearchProvider,
		TimeoutMs:          cfg.WebSearchTimeoutMs,
		DuckDuckGoEndpoint: cfg.WebSearchDuckEndpoint,
		BraveEndpoint:      cfg.WebSearchBraveEndpoint,
		BraveAPIKey:        cfg.WebSearchBraveAPIKey,
		SearxngEndpoint:    cfg.WebSearchSearxngEndpoint,
		SearxngAPIKey:      cfg.WebSearchSearxngAPIKey,
		SerpAPIEndpoint:    cfg.WebSearchSerpAPIEndpoint,
		SerpAPIKey:         cfg.WebSearchSerpAPIKey,
	})
	schedulerHandler := handler.NewSchedulerHandler(clients)

	// ── Public ────────────────────────────────────────────────────────────────
	r.Post("/auth/login", authHandler.Login)
	r.Post("/auth/signup", authHandler.Signup)
	r.Post("/auth/refresh", authHandler.Refresh)

	// Public webhook endpoint (signature verified in TS)
	r.Post("/webhooks/{channelId}", channelsHandler.HandleWebhook)

	// Public runtime endpoint (X-Runtime-Secret auth, no user JWT)
	r.Post("/channels/{channelId}/send", channelsHandler.SendChannelMessage)
	r.Post("/internal/tools/web-search", runtimeToolsHandler.WebSearch)

	// ── Protected ─────────────────────────────────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(middleware.Auth(cfg.JWTSecret))

		// Auth
		r.Post("/auth/logout", authHandler.Logout)
		r.Get("/auth/me", authHandler.Me)

		// Orgs
		r.Get("/orgs", orgHandler.ListOrgs)
		r.Get("/orgs/{slug}", orgHandler.GetOrg)
		r.Patch("/orgs/{slug}", orgHandler.UpdateOrg)
		r.Get("/orgs/{slug}/members", orgHandler.ListMembers)
		r.Get("/orgs/{slug}/workspaces", orgHandler.ListWorkspaces)
		r.Get("/orgs/{orgId}/dashboard/stats", orgHandler.GetDashboardStats)
		r.Get("/orgs/{orgId}/dashboard/token-stats", orgHandler.GetDashboardTokenStats)
		r.Get("/orgs/{orgId}/dashboard/workload", orgHandler.GetDashboardWorkload)
		r.Get("/orgs/{orgId}/dashboard/activities", orgHandler.GetDashboardActivities)
		r.Get("/orgs/{orgId}/usage/overview", orgHandler.GetUsageOverview)
		r.Get("/orgs/{orgId}/usage/metrics", orgHandler.GetUsageMetrics)
		r.Get("/orgs/{orgId}/usage/token-trend", orgHandler.GetUsageTokenTrend)
		r.Get("/orgs/{orgId}/usage/providers", orgHandler.GetUsageProviders)
		r.Get("/orgs/{orgId}/usage/agent-ranking", orgHandler.GetUsageAgentRanking)
		r.Get("/orgs/{orgId}/usage/records", orgHandler.ListUsageRecords)

		// Workspaces
		r.Post("/workspaces", wsHandler.CreateWorkspace)
		r.Get("/workspaces/{wsId}", wsHandler.GetWorkspace)
		r.Patch("/workspaces/{wsId}", wsHandler.UpdateWorkspace)
		r.Delete("/workspaces/{wsId}", wsHandler.DeleteWorkspace)

		// Plugins — marketplace + installed
		r.Get("/plugins/marketplace", pluginHandler.ListMarketplace)
		r.Get("/plugins/marketplace/{pluginId}", pluginHandler.GetMarketplacePlugin)
		r.Get("/plugins/marketplace/{pluginId}/reviews", pluginHandler.ListPluginReviews)
		r.Get("/workspaces/{wsId}/plugins", pluginHandler.ListWorkspacePlugins)
		r.Post("/workspaces/{wsId}/plugins", pluginHandler.InstallWorkspacePlugin)
		r.Patch("/workspaces/{wsId}/plugins/{pluginId}", pluginHandler.UpdateWorkspacePlugin)
		r.Patch("/workspaces/{wsId}/plugins/{pluginId}/config", pluginHandler.UpdateWorkspacePluginConfig)
		r.Delete("/workspaces/{wsId}/plugins/{pluginId}", pluginHandler.UninstallWorkspacePlugin)

		// Settings — providers (match frontend: /workspaces/:wsId/providers/*)
		r.Get("/workspaces/{wsId}/providers", settingsHandler.ListProviders)
		r.Post("/workspaces/{wsId}/providers", settingsHandler.CreateProvider)
		r.Patch("/workspaces/{wsId}/providers/{providerId}", settingsHandler.UpdateProvider)
		r.Delete("/workspaces/{wsId}/providers/{providerId}", settingsHandler.DeleteProvider)
		r.Post("/workspaces/{wsId}/providers/{providerId}/test", settingsHandler.TestProvider)

		// Settings — models (match frontend: /workspaces/:wsId/providers/:id/models/*)
		r.Get("/workspaces/{wsId}/providers/{providerId}/models", settingsHandler.ListModels)
		r.Post("/workspaces/{wsId}/providers/{providerId}/models", settingsHandler.CreateModel)
		r.Patch("/workspaces/{wsId}/providers/{providerId}/models/{modelId}", settingsHandler.UpdateModel)
		r.Delete("/workspaces/{wsId}/providers/{providerId}/models/{modelId}", settingsHandler.DeleteModel)
		r.Get("/workspaces/{wsId}/all-models", settingsHandler.ListAllModels)

		// Settings — API keys (match frontend: /workspaces/:wsId/api-keys)
		r.Get("/workspaces/{wsId}/api-keys", settingsHandler.ListApiKeys)
		r.Post("/workspaces/{wsId}/api-keys", settingsHandler.CreateApiKey)
		r.Delete("/workspaces/{wsId}/api-keys/{keyId}", settingsHandler.DeleteApiKey)

		// Chat — sessions
		r.Get("/workspaces/{wsId}/sessions", chatHandler.ListSessions)
		r.Get("/workspaces/{wsId}/runtime/metrics", chatHandler.GetRuntimeMetrics)
		r.Get("/workspaces/{wsId}/usage/records", chatHandler.ListUsageRecords)
		r.Post("/workspaces/{wsId}/plugin-usage/events", chatHandler.ReportPluginUsageEvents)
		r.Post("/workspaces/{wsId}/sessions", chatHandler.CreateSession)
		r.Patch("/sessions/{sessionId}", chatHandler.UpdateSession)
		r.Delete("/sessions/{sessionId}", chatHandler.DeleteSession)

		// Chat — messages
		r.Get("/sessions/{sessionId}/messages", chatHandler.ListMessages)
		r.Post("/sessions/{sessionId}/messages", chatHandler.SaveUserMessage)
		r.Patch("/sessions/{sessionId}/messages/{messageId}", chatHandler.UpdateUserMessage)

		// Chat — agents
		r.Get("/workspaces/{wsId}/agents", chatHandler.ListAgents)
		r.Post("/workspaces/{wsId}/agents", chatHandler.CreateAgent)
		r.Get("/agents/{agentId}", chatHandler.GetAgent)
		r.Patch("/agents/{agentId}", chatHandler.UpdateAgent)
		r.Delete("/agents/{agentId}", chatHandler.DeleteAgent)

		// Tools
		r.Get("/workspaces/{wsId}/tools", toolsHandler.ListTools)
		r.Get("/workspaces/{wsId}/tool-auth", toolsHandler.ListToolAuthorizations)
		r.Post("/workspaces/{wsId}/tool-auth", toolsHandler.UpsertToolAuthorization)

		// Channels — workspace-scoped (list + create)
		r.Get("/workspaces/{wsId}/channels", channelsHandler.ListChannels)
		r.Post("/workspaces/{wsId}/channels", channelsHandler.CreateChannel)
		r.Post("/channels/test", channelsHandler.TestConnection)

		// Channels — channel-scoped (match frontend: /channels/:channelId/*)
		r.Get("/channels/{channelId}", channelsHandler.GetChannel)
		r.Patch("/channels/{channelId}", channelsHandler.UpdateChannel)
		r.Delete("/channels/{channelId}", channelsHandler.DeleteChannel)
		r.Get("/channels/{channelId}/messages", channelsHandler.ListChannelMessages)
		r.Get("/channels/{channelId}/rules", channelsHandler.ListRoutingRules)
		r.Post("/channels/{channelId}/rules", channelsHandler.CreateRoutingRule)
		r.Patch("/channels/{channelId}/rules/{ruleId}", channelsHandler.UpdateRoutingRule)
		r.Delete("/channels/{channelId}/rules/{ruleId}", channelsHandler.DeleteRoutingRule)

		// Scheduler
		r.Get("/workspaces/{wsId}/scheduler/tasks", schedulerHandler.ListTasks)
		r.Post("/workspaces/{wsId}/scheduler/tasks", schedulerHandler.CreateTask)
		r.Patch("/workspaces/{wsId}/scheduler/tasks/{taskId}", schedulerHandler.UpdateTask)
		r.Delete("/workspaces/{wsId}/scheduler/tasks/{taskId}", schedulerHandler.DeleteTask)
		r.Post("/workspaces/{wsId}/scheduler/tasks/{taskId}/run", schedulerHandler.RunTask)
		r.Get("/workspaces/{wsId}/scheduler/tasks/{taskId}/executions", schedulerHandler.ListExecutions)

		// LLM proxy → Bifrost sidecar
		r.Handle("/v1/*", stream.BifrostProxy(cfg.BifrostAddr))

		// Agent Runtime proxy → Runtime process (:8082)
		r.Handle("/runtime/*", stream.RuntimeProxy(cfg.RuntimeAddr))
	})

	log.Printf("Gateway listening on :%s (gRPC → %s, Bifrost → %s, Runtime → %s)", cfg.Port, cfg.GRPCAddr, cfg.BifrostAddr, cfg.RuntimeAddr)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
