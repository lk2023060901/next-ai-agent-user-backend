package handler

import (
	"errors"
	"net/http"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/middleware"
	"github.com/nextai-agent/gateway/internal/service"
)

var authLog = logger.Named("auth")

type AuthHandler struct {
	auth *service.AuthService
}

func NewAuthHandler(auth *service.AuthService) *AuthHandler {
	return &AuthHandler{auth: auth}
}

// MountPublic registers unauthenticated auth routes.
func (h *AuthHandler) MountPublic(r chi.Router) {
	r.Post("/auth/login", h.Login)
	r.Post("/auth/signup", h.Signup)
	r.Post("/auth/refresh", h.Refresh)
}

// Mount registers authenticated auth routes.
func (h *AuthHandler) Mount(r chi.Router) {
	r.Get("/auth/me", h.Me)
}

func (h *AuthHandler) Signup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeBody(r, &body); err != nil {
		authLog.Warn("signup: invalid body", zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Email == "" || body.Password == "" || body.Name == "" {
		authLog.Warn("signup: missing fields", zap.String("email", body.Email))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name, email and password are required")
		return
	}

	user, tokens, err := h.auth.Signup(r.Context(), body.Name, body.Email, body.Password)
	if err != nil {
		if errors.Is(err, service.ErrUserExists) {
			authLog.Debug("signup: user already exists", zap.String("email", body.Email))
			writeError(w, http.StatusConflict, "USER_ALREADY_EXISTS", "该邮箱已注册")
			return
		}
		authLog.Error("signup failed", zap.String("email", body.Email), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "注册失败")
		return
	}

	authLog.Debug("signup success", zap.String("userId", user.ID), zap.String("email", user.Email))
	writeData(w, map[string]interface{}{"user": user, "tokens": tokens})
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeBody(r, &body); err != nil {
		authLog.Warn("login: invalid body", zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Email == "" || body.Password == "" {
		authLog.Warn("login: missing fields")
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "email and password are required")
		return
	}

	user, tokens, err := h.auth.Login(r.Context(), body.Email, body.Password)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			authLog.Debug("login: invalid credentials", zap.String("email", body.Email))
			writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "邮箱或密码错误")
			return
		}
		authLog.Error("login failed", zap.String("email", body.Email), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "登录失败")
		return
	}

	authLog.Debug("login success", zap.String("userId", user.ID), zap.String("email", user.Email))
	writeData(w, map[string]interface{}{"user": user, "tokens": tokens})
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := decodeBody(r, &body); err != nil {
		authLog.Warn("refresh: invalid body", zap.Error(err))
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "refreshToken is required")
		return
	}

	tokens, err := h.auth.Refresh(r.Context(), body.RefreshToken)
	if err != nil {
		if errors.Is(err, service.ErrInvalidRefreshToken) {
			authLog.Debug("refresh: invalid token")
			writeError(w, http.StatusUnauthorized, "INVALID_REFRESH_TOKEN", "refresh token 无效或已过期")
			return
		}
		authLog.Error("refresh failed", zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "刷新失败")
		return
	}

	authLog.Debug("refresh success")
	writeData(w, tokens)
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	user, err := h.auth.GetUser(r.Context(), userID)
	if err != nil || user == nil {
		authLog.Error("me: user not found", zap.String("userId", userID), zap.Error(err))
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "用户不存在")
		return
	}
	authLog.Debug("me success", zap.String("userId", userID))
	writeData(w, user)
}
