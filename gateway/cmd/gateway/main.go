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

	// M3: Warn when default/insecure secrets are in use
	for _, warning := range cfg.Validate() {
		log.Printf("WARNING: %s", warning)
	}

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
		AllowedHeaders:   []string{"Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID", "X-Runtime-Secret"},
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
		r.Get("/orgs/{orgId}", orgHandler.GetOrg)
		r.Patch("/orgs/{orgId}", orgHandler.UpdateOrg)
		r.Get("/orgs/{orgId}/members", orgHandler.ListMembers)
		r.Get("/orgs/{orgId}/workspaces", orgHandler.ListWorkspaces)
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
		r.Post("/plugins/marketplace/{pluginId}/favorite", pluginHandler.SetPluginFavorite)
		r.Post("/plugins/marketplace/{pluginId}/reviews", pluginHandler.UpsertPluginReview)
		r.Get("/workspaces/{wsId}/plugins", pluginHandler.ListWorkspacePlugins)
		r.Post("/workspaces/{wsId}/plugins", pluginHandler.InstallWorkspacePlugin)
		r.Patch("/workspaces/{wsId}/plugins/{pluginId}", pluginHandler.UpdateWorkspacePlugin)
		r.Patch("/workspaces/{wsId}/plugins/{pluginId}/config", pluginHandler.UpdateWorkspacePluginConfig)
		r.Delete("/workspaces/{wsId}/plugins/{pluginId}", pluginHandler.UninstallWorkspacePlugin)

		// Settings — providers (match frontend: /workspaces/:wsId/providers/*)
		r.Get("/workspaces/{wsId}/settings", settingsHandler.GetWorkspaceSettings)
		r.Patch("/workspaces/{wsId}/settings", settingsHandler.UpdateWorkspaceSettings)
		r.Get("/workspaces/{wsId}/providers", settingsHandler.ListProviders)
		r.Post("/workspaces/{wsId}/providers", settingsHandler.CreateProvider)
		r.Patch("/workspaces/{wsId}/providers/{providerId}", settingsHandler.UpdateProvider)
		r.Delete("/workspaces/{wsId}/providers/{providerId}", settingsHandler.DeleteProvider)
		r.Post("/workspaces/{wsId}/providers/{providerId}/test", settingsHandler.TestProvider)
		r.Get("/workspaces/{wsId}/runtime/providers", settingsHandler.ListProviders)
		r.Post("/workspaces/{wsId}/runtime/providers/custom", settingsHandler.CreateProvider)
		r.Patch("/workspaces/{wsId}/runtime/providers/custom/{providerId}", settingsHandler.UpdateProvider)
		r.Delete("/workspaces/{wsId}/runtime/providers/custom/{providerId}", settingsHandler.DeleteProvider)
		r.Put("/workspaces/{wsId}/runtime/providers/{providerId}/override", settingsHandler.UpdateProvider)
		r.Delete("/workspaces/{wsId}/runtime/providers/{providerId}/override", settingsHandler.DeleteProvider)
		r.Post("/workspaces/{wsId}/runtime/providers/{providerId}/test", settingsHandler.TestProvider)

		// Settings — models (match frontend: /workspaces/:wsId/providers/:id/models/*)
		r.Get("/workspaces/{wsId}/providers/{providerId}/models", settingsHandler.ListModels)
		r.Get("/workspaces/{wsId}/providers/{providerId}/catalog", settingsHandler.ListModelCatalog)
		r.Post("/workspaces/{wsId}/providers/{providerId}/models", settingsHandler.CreateModel)
		r.Patch("/workspaces/{wsId}/providers/{providerId}/models/{modelId}", settingsHandler.UpdateModel)
		r.Delete("/workspaces/{wsId}/providers/{providerId}/models/{modelId}", settingsHandler.DeleteModel)
		r.Get("/workspaces/{wsId}/all-models", settingsHandler.ListAllModels)
		r.Get("/workspaces/{wsId}/runtime/providers/{providerId}/models", settingsHandler.ListModels)
		r.Get("/workspaces/{wsId}/runtime/providers/{providerId}/catalog", settingsHandler.ListModelCatalog)
		r.Post("/workspaces/{wsId}/runtime/providers/{providerId}/models/custom", settingsHandler.CreateModel)
		r.Patch("/workspaces/{wsId}/runtime/providers/{providerId}/models/custom/{modelId}", settingsHandler.UpdateModel)
		r.Delete("/workspaces/{wsId}/runtime/providers/{providerId}/models/custom/{modelId}", settingsHandler.DeleteModel)
		r.Put("/workspaces/{wsId}/runtime/providers/{providerId}/models/{modelId}/override", settingsHandler.UpdateModel)
		r.Delete("/workspaces/{wsId}/runtime/providers/{providerId}/models/{modelId}/override", settingsHandler.DeleteModel)

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
		r.Get("/workspaces/{wsId}/workflows", chatHandler.ListWorkflows)
		r.Post("/workspaces/{wsId}/workflows", chatHandler.CreateWorkflow)
		r.Get("/workflows/{workflowId}", chatHandler.GetWorkflow)
		r.Patch("/workflows/{workflowId}", chatHandler.UpdateWorkflow)
		r.Post("/workflows/{workflowId}/validate", chatHandler.ValidateWorkflow)
		r.Post("/workflows/validate", chatHandler.ValidateWorkflow)
		r.Get("/workflow/node-types", chatHandler.ListWorkflowNodeTypes)
		r.Get("/workflows/node-types", chatHandler.ListWorkflowNodeTypes)
		r.Get("/workspaces/{wsId}/blueprint", chatHandler.GetBlueprint)
		r.Put("/workspaces/{wsId}/blueprint", chatHandler.SaveBlueprint)

		// Tools
		r.Get("/workspaces/{wsId}/tools", toolsHandler.ListTools)
		r.Get("/workspaces/{wsId}/tool-auth", toolsHandler.ListToolAuthorizations)
		r.Post("/workspaces/{wsId}/tool-auth", toolsHandler.UpsertToolAuthorization)
		r.Get("/workspaces/{wsId}/knowledge-bases", toolsHandler.ListKnowledgeBases)
		r.Post("/workspaces/{wsId}/knowledge-bases", toolsHandler.CreateKnowledgeBase)
		r.Patch("/knowledge-bases/{kbId}", toolsHandler.UpdateKnowledgeBase)
		r.Delete("/knowledge-bases/{kbId}", toolsHandler.DeleteKnowledgeBase)
		r.Get("/knowledge-bases/{kbId}/documents", toolsHandler.ListKnowledgeBaseDocuments)
		r.Post("/knowledge-bases/{kbId}/documents", toolsHandler.CreateKnowledgeBaseDocument)
		r.Delete("/knowledge-bases/{kbId}/documents/{docId}", toolsHandler.DeleteKnowledgeBaseDocument)
		r.Post("/knowledge-bases/{kbId}/search", toolsHandler.SearchKnowledgeBase)

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
	})

	// ── Runtime proxy (JWT or X-Runtime-Secret) ──────────────────────────────
	// H3: /runtime/* accepts either JWT (user-facing) or X-Runtime-Secret
	// (service-to-service). This allows scheduled tasks, channel runs, and
	// monitoring to reach runtime endpoints through the gateway without JWT.
	r.Group(func(r chi.Router) {
		r.Use(middleware.AuthOrRuntimeSecret(cfg.JWTSecret, cfg.RuntimeSecret))
		r.Handle("/runtime/*", stream.RuntimeProxy(cfg.RuntimeAddr))
	})

	log.Printf("Gateway listening on :%s (gRPC → %s, Bifrost → %s, Runtime → %s)", cfg.Port, cfg.GRPCAddr, cfg.BifrostAddr, cfg.RuntimeAddr)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
