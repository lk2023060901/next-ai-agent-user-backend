package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/nextai-agent/gateway/internal/config"
	"github.com/nextai-agent/gateway/internal/handler"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/middleware"
	"github.com/nextai-agent/gateway/internal/service"
	"github.com/nextai-agent/gateway/internal/store"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()

	logger.Init(cfg.Env, logger.Options{
		File: cfg.Log.File, MaxSizeMB: cfg.Log.MaxSizeMB,
		MaxBackups: cfg.Log.MaxBackups, MaxAgeDays: cfg.Log.MaxAgeDays,
	})
	defer logger.Sync()

	pool, err := store.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("database connection failed", zap.Error(err))
	}
	defer pool.Close()

	db := store.NewDB(pool)

	if err := store.RunMigrations(ctx, pool, "migrations"); err != nil {
		logger.Fatal("migrations failed", zap.Error(err))
	}
	logger.Info("migrations applied")

	// Services
	authSvc := service.NewAuthService(
		store.NewUserStore(db), store.NewOrgStore(db), store.NewTokenStore(db), cfg.JWTSecret,
	)
	workflowOutputStorage, err := service.NewWorkflowOutputStorage(ctx, cfg.WorkflowOutputStorage)
	if err != nil {
		logger.Fatal("workflow output storage init failed", zap.Error(err))
	}

	// Handlers
	authH := handler.NewAuthHandler(authSvc)
	orgH := handler.NewOrgHandler(store.NewOrgStore(db))
	agentH := handler.NewAgentHandler(store.NewAgentStore(db))
	sessionH := handler.NewSessionHandler(store.NewSessionStore(db))
	dashH := handler.NewDashboardHandler(store.NewDashboardStore(db))
	settingsH := handler.NewSettingsHandler(store.NewProviderStore(db))
	kbH := handler.NewKnowledgeHandler(store.NewKnowledgeStore(db))
	channelH := handler.NewChannelHandler(store.NewChannelStore(db))
	pluginH := handler.NewPluginHandler(db)
	schedH := handler.NewSchedulerHandler(db)
	issueStore := store.NewIssueStore(db)
	agentStore := store.NewAgentStore(db)
	monH := handler.NewMonitoringHandler(db, issueStore)
	billH := handler.NewBillingHandler(db)
	wfH := handler.NewWorkflowHandler(store.NewWorkflowStore(db))
	topologyH := handler.NewTopologyHandler(store.NewTopologyStore(db))
	wfRunH := handler.NewWorkflowRunHandler(cfg.RuntimeBaseURL, store.NewWorkflowRunStore(db), workflowOutputStorage)
	issueH := handler.NewIssueHandler(cfg.RuntimeBaseURL, issueStore, agentStore)
	approvalH := handler.NewApprovalHandler(issueStore)

	// Router
	r := chi.NewRouter()
	r.Use(chimw.Logger, chimw.Recoverer, corsMiddleware)

	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	})

	r.Route("/api", func(r chi.Router) {
		authH.MountPublic(r)

		r.Group(func(r chi.Router) {
			r.Use(middleware.Auth(authSvc))
			authH.Mount(r)
			orgH.Mount(r)
			agentH.Mount(r)
			sessionH.Mount(r)
			dashH.Mount(r)
			settingsH.Mount(r)
			kbH.Mount(r)
			channelH.Mount(r)
			pluginH.Mount(r)
			schedH.Mount(r)
			monH.Mount(r)
			billH.Mount(r)
			wfH.Mount(r)
			topologyH.Mount(r)
			wfRunH.Mount(r)
			issueH.Mount(r)
			approvalH.Mount(r)
		})
	})

	// Start
	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}
	go func() {
		logger.Info("gateway listening", zap.String("port", cfg.Port))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("listen failed", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Fatal("shutdown failed", zap.Error(err))
	}
	logger.Info("gateway stopped")
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
