package handler

import (
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/store"
)

var pluginLog = logger.Named("plugin")

type PluginHandler struct {
	db *store.DB
}

func NewPluginHandler(db *store.DB) *PluginHandler {
	return &PluginHandler{db: db}
}

func (h *PluginHandler) Mount(r chi.Router) {
	r.Get("/plugins/marketplace", h.Marketplace)
	r.Get("/plugins/marketplace/{pluginId}", h.GetPlugin)
	r.Get("/plugins/marketplace/{pluginId}/reviews", h.GetReviews)
	r.Get("/workspaces/{wsId}/plugins", h.ListInstalled)
	r.Post("/workspaces/{wsId}/plugins", h.Install)
	r.Delete("/workspaces/{wsId}/plugins/{pluginId}", h.Uninstall)
	r.Patch("/workspaces/{wsId}/plugins/{pluginId}", h.Toggle)
	r.Patch("/workspaces/{wsId}/plugins/{pluginId}/config", h.UpdateConfig)
}

func (h *PluginHandler) Marketplace(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Query(r.Context(),
		store.Select("id", "name", "display_name", "description", "author", "author_avatar",
			"icon", "type", "version", "pricing_model", "price", "monthly_price", "trial_days",
			"rating", "review_count", "install_count", "favorite_count", "tags", "permissions",
			"screenshots", "published_at", "updated_at").
			From("plugins").OrderBy("install_count DESC"))
	if err != nil {
		pluginLog.Error("marketplace query failed", zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取插件市场失败")
		return
	}
	defer rows.Close()

	var plugins []map[string]interface{}
	cols := rows.FieldDescriptions()
	for rows.Next() {
		vals, _ := rows.Values()
		m := make(map[string]interface{})
		for i, c := range cols {
			m[string(c.Name)] = vals[i]
		}
		plugins = append(plugins, m)
	}
	if plugins == nil {
		plugins = []map[string]interface{}{}
	}
	pluginLog.Debug("marketplace", zap.Int("count", len(plugins)))
	writeData(w, plugins)
}

func (h *PluginHandler) GetPlugin(w http.ResponseWriter, r *http.Request) {
	pluginID := chi.URLParam(r, "pluginId")
	pluginLog.Debug("get plugin", zap.String("pluginId", pluginID))
	writeError(w, http.StatusNotFound, "NOT_FOUND", "插件不存在")
}

func (h *PluginHandler) GetReviews(w http.ResponseWriter, r *http.Request) {
	writeData(w, []interface{}{})
}

func (h *PluginHandler) ListInstalled(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	rows, err := h.db.Query(r.Context(),
		store.Select("ip.id", "ip.workspace_id", "ip.plugin_id", "ip.status", "ip.config",
			"ip.installed_at", "ip.installed_by",
			"p.name", "p.display_name", "p.description", "p.icon", "p.type", "p.version").
			From("installed_plugins ip").
			Join("plugins p ON p.id = ip.plugin_id").
			Where("ip.workspace_id = ?", wsID))
	if err != nil {
		pluginLog.Error("list installed failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取已安装插件失败")
		return
	}
	defer rows.Close()

	var installed []map[string]interface{}
	for rows.Next() {
		var id, wsid, pid, status, installedBy, pName, pDisplayName, pDesc, pIcon, pType, pVersion string
		var config []byte
		var installedAt interface{}
		rows.Scan(&id, &wsid, &pid, &status, &config, &installedAt, &installedBy,
			&pName, &pDisplayName, &pDesc, &pIcon, &pType, &pVersion)
		installed = append(installed, map[string]interface{}{
			"id": id, "workspaceId": wsid, "pluginId": pid, "status": status,
			"installedAt": installedAt, "installedBy": installedBy,
			"plugin": map[string]interface{}{
				"id": pid, "name": pName, "displayName": pDisplayName,
				"description": pDesc, "icon": pIcon, "type": pType, "version": pVersion,
			},
		})
	}
	if installed == nil {
		installed = []map[string]interface{}{}
	}
	pluginLog.Debug("list installed", zap.String("wsId", wsID), zap.Int("count", len(installed)))
	writeData(w, installed)
}

func (h *PluginHandler) Install(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		PluginID string                 `json:"pluginId"`
		Config   map[string]interface{} `json:"config"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	pluginLog.Debug("install plugin", zap.String("wsId", wsID), zap.String("pluginId", body.PluginID))
	writeError(w, http.StatusNotFound, "NOT_FOUND", "插件不存在")
}

func (h *PluginHandler) Uninstall(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	pluginID := chi.URLParam(r, "pluginId")
	_ = h.db.Exec(r.Context(), store.Delete("installed_plugins").Where("workspace_id = ? AND plugin_id = ?", wsID, pluginID))
	pluginLog.Debug("uninstall plugin", zap.String("wsId", wsID), zap.String("pluginId", pluginID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *PluginHandler) Toggle(w http.ResponseWriter, r *http.Request) {
	pluginLog.Debug("toggle plugin")
	writeData(w, map[string]interface{}{"status": "enabled"})
}

func (h *PluginHandler) UpdateConfig(w http.ResponseWriter, r *http.Request) {
	pluginLog.Debug("update plugin config")
	writeData(w, map[string]interface{}{})
}
