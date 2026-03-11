package middleware

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// secureCompare performs a constant-time comparison of two strings
// to prevent timing attacks on secret values.
func secureCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

type contextKey string

const (
	UserContextKey contextKey = "user"
	RequestIDKey   contextKey = "requestID"
)

type UserClaims struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = uuid.New().String()
		}
		ctx := context.WithValue(r.Context(), RequestIDKey, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func Auth(jwtSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			tokenStr := strings.TrimPrefix(header, "Bearer ")
			claims := &jwt.MapClaims{}
			token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
				return []byte(jwtSecret), nil
			})
			if err != nil || !token.Valid {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}
			user, ok := extractUserClaims(claims)
			if !ok {
				http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
				return
			}
			ctx := context.WithValue(r.Context(), UserContextKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func extractUserClaims(claims *jwt.MapClaims) (UserClaims, bool) {
	userID, ok := (*claims)["user_id"].(string)
	if !ok || userID == "" {
		return UserClaims{}, false
	}
	email, _ := (*claims)["email"].(string)
	name, _ := (*claims)["name"].(string)
	return UserClaims{UserID: userID, Email: email, Name: name}, true
}

func GetUser(r *http.Request) (UserClaims, bool) {
	u, ok := r.Context().Value(UserContextKey).(UserClaims)
	return u, ok
}

// AuthOrRuntimeSecret accepts either a valid JWT Bearer token or a valid
// X-Runtime-Secret header. This allows both user-initiated requests (JWT)
// and service-to-service requests (runtime secret) to reach /runtime/*
// endpoints through the gateway.
func AuthOrRuntimeSecret(jwtSecret, runtimeSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Try X-Runtime-Secret first (fast path for internal calls)
			if secret := r.Header.Get("X-Runtime-Secret"); secret != "" {
				if secureCompare(secret, runtimeSecret) {
					next.ServeHTTP(w, r)
					return
				}
				http.Error(w, `{"error":"invalid runtime secret"}`, http.StatusUnauthorized)
				return
			}

			// Fall back to JWT auth
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			tokenStr := strings.TrimPrefix(header, "Bearer ")
			claims := &jwt.MapClaims{}
			token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
				return []byte(jwtSecret), nil
			})
			if err != nil || !token.Valid {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}
			user, ok := extractUserClaims(claims)
			if !ok {
				http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
				return
			}
			ctx := context.WithValue(r.Context(), UserContextKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
