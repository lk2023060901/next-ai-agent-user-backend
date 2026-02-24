package handler

import (
	"encoding/json"
	"net/http"

	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	authpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/auth"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
)

type AuthHandler struct {
	clients *grpcclient.Clients
}

func NewAuthHandler(clients *grpcclient.Clients) *AuthHandler {
	return &AuthHandler{clients: clients}
}

// authResponse shapes the response to match frontend expectation:
// { data: { user: {...}, tokens: { accessToken, refreshToken, expiresIn } } }
func authResponse(resp *authpb.AuthResponse) map[string]any {
	return map[string]any{
		"data": map[string]any{
			"user": map[string]any{
				"id":        resp.User.Id,
				"name":      resp.User.Name,
				"email":     resp.User.Email,
				"avatarUrl": resp.User.AvatarUrl,
				"createdAt": resp.User.CreatedAt,
				"updatedAt": resp.User.CreatedAt,
			},
			"tokens": map[string]any{
				"accessToken":  resp.AccessToken,
				"refreshToken": resp.RefreshToken,
				"expiresIn":    900,
			},
		},
	}
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req authpb.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Auth.Login(r.Context(), &req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, authResponse(resp))
}

func (h *AuthHandler) Signup(w http.ResponseWriter, r *http.Request) {
	var req authpb.SignupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Auth.Signup(r.Context(), &req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, authResponse(resp))
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	user, _ := middleware.GetUser(r)
	_, err := h.clients.Auth.Logout(r.Context(), &authpb.LogoutRequest{
		RefreshToken: body.RefreshToken,
		UserContext: &commonpb.UserContext{
			UserId: user.UserID,
			Email:  user.Email,
			Name:   user.Name,
		},
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	resp, err := h.clients.Auth.RefreshToken(r.Context(), &authpb.RefreshTokenRequest{
		RefreshToken: body.RefreshToken,
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
			"expiresIn":    900,
		},
	})
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.GetUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	resp, err := h.clients.Auth.GetMe(r.Context(), &authpb.GetMeRequest{
		UserContext: &commonpb.UserContext{
			UserId: user.UserID,
			Email:  user.Email,
			Name:   user.Name,
		},
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"id":        resp.Id,
			"name":      resp.Name,
			"email":     resp.Email,
			"avatarUrl": resp.AvatarUrl,
			"createdAt": resp.CreatedAt,
			"updatedAt": resp.CreatedAt,
		},
	})
}
