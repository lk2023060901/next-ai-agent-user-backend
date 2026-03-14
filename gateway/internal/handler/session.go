package handler

import (
	"net/http"
	"strconv"
	"time"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var sessionLog = logger.Named("session")

type SessionHandler struct {
	sessions *store.SessionStore
}

func NewSessionHandler(sessions *store.SessionStore) *SessionHandler {
	return &SessionHandler{sessions: sessions}
}

func (h *SessionHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/sessions", h.List)
	r.Post("/workspaces/{wsId}/sessions", h.Create)
	r.Patch("/sessions/{sessionId}", h.Update)
	r.Delete("/sessions/{sessionId}", h.Delete)
	r.Get("/sessions/{sessionId}/messages", h.ListMessages)
	r.Post("/sessions/{sessionId}/messages", h.SendMessage)
	r.Patch("/sessions/{sessionId}/messages/{messageId}", h.EditMessage)
}

func (h *SessionHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	sessions, err := h.sessions.List(r.Context(), wsID)
	if err != nil {
		sessionLog.Error("list sessions failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取会话列表失败")
		return
	}
	if sessions == nil {
		sessions = []model.Session{}
	}
	sessionLog.Debug("list sessions", zap.String("workspaceId", wsID), zap.Int("count", len(sessions)))
	writeData(w, sessions)
}

func (h *SessionHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Title string `json:"title"`
	}
	if err := decodeBody(r, &body); err != nil {
		sessionLog.Warn("create session: invalid body", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Title == "" {
		body.Title = "新会话"
	}
	sess, err := h.sessions.Create(r.Context(), wsID, body.Title)
	if err != nil {
		sessionLog.Error("create session failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建会话失败")
		return
	}
	sessionLog.Debug("create session", zap.String("sessionId", sess.ID), zap.String("title", sess.Title))
	writeJSON(w, http.StatusCreated, apiResponse{Data: sess})
}

func (h *SessionHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "sessionId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		sessionLog.Warn("update session: invalid body", zap.String("sessionId", id), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	dbFields := make(map[string]interface{})
	if v, ok := body["title"]; ok {
		dbFields["title"] = v
	}
	if v, ok := body["status"]; ok {
		dbFields["status"] = v
	}
	if v, ok := body["isPinned"]; ok {
		dbFields["is_pinned"] = v
		if pinned, isBool := v.(bool); isBool && pinned {
			dbFields["pinned_at"] = time.Now()
		} else {
			dbFields["pinned_at"] = nil
		}
	}
	if len(dbFields) == 0 {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "no fields to update")
		return
	}
	sess, err := h.sessions.Update(r.Context(), id, dbFields)
	if err != nil {
		sessionLog.Error("update session failed", zap.String("sessionId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新会话失败")
		return
	}
	sessionLog.Debug("update session", zap.String("sessionId", id))
	writeData(w, sess)
}

func (h *SessionHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "sessionId")
	if err := h.sessions.Delete(r.Context(), id); err != nil {
		sessionLog.Error("delete session failed", zap.String("sessionId", id), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除会话失败")
		return
	}
	sessionLog.Debug("delete session", zap.String("sessionId", id))
	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	limit := 40
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = v
	}
	var beforePtr *string
	if b := r.URL.Query().Get("beforeMessageId"); b != "" {
		beforePtr = &b
	}
	page, err := h.sessions.ListMessages(r.Context(), sessionID, limit, beforePtr)
	if err != nil {
		sessionLog.Error("list messages failed", zap.String("sessionId", sessionID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取消息列表失败")
		return
	}
	if page.Messages == nil {
		page.Messages = []model.Message{}
	}
	sessionLog.Debug("list messages", zap.String("sessionId", sessionID), zap.Int("count", len(page.Messages)))
	writeData(w, page)
}

func (h *SessionHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	var body struct {
		Content string `json:"content"`
	}
	if err := decodeBody(r, &body); err != nil {
		sessionLog.Warn("send message: invalid body", zap.String("sessionId", sessionID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Content == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "content is required")
		return
	}
	msg, err := h.sessions.CreateMessage(r.Context(), sessionID, "user", body.Content)
	if err != nil {
		sessionLog.Error("send message failed", zap.String("sessionId", sessionID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "发送消息失败")
		return
	}
	sessionLog.Debug("send message", zap.String("sessionId", sessionID), zap.String("messageId", msg.ID))
	writeJSON(w, http.StatusCreated, apiResponse{Data: msg})
}

func (h *SessionHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	messageID := chi.URLParam(r, "messageId")
	var body struct {
		Content string `json:"content"`
	}
	if err := decodeBody(r, &body); err != nil {
		sessionLog.Warn("edit message: invalid body", zap.String("sessionId", sessionID), zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	msg, removedIDs, err := h.sessions.UpdateMessage(r.Context(), sessionID, messageID, body.Content)
	if err != nil {
		sessionLog.Error("edit message failed", zap.String("sessionId", sessionID), zap.String("messageId", messageID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "编辑消息失败")
		return
	}
	if removedIDs == nil {
		removedIDs = []string{}
	}
	sessionLog.Debug("edit message", zap.String("sessionId", sessionID), zap.String("messageId", messageID), zap.Int("removedCount", len(removedIDs)))
	writeData(w, map[string]interface{}{"message": msg, "removedMessageIds": removedIDs})
}
