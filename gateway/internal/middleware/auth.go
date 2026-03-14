package middleware

import (
	"context"
	"net/http"
	"strings"

	"go.uber.org/zap"

	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/service"
)

var authLog = logger.Named("auth-middleware")

type contextKey string

const UserIDKey contextKey = "userID"

func Auth(authSvc *service.AuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				authLog.Debug("missing authorization header", zap.String("path", r.URL.Path))
				http.Error(w, `{"code":"UNAUTHORIZED","message":"missing token"}`, http.StatusUnauthorized)
				return
			}

			token := strings.TrimPrefix(header, "Bearer ")
			if token == header {
				authLog.Warn("invalid token format", zap.String("path", r.URL.Path))
				http.Error(w, `{"code":"UNAUTHORIZED","message":"invalid token format"}`, http.StatusUnauthorized)
				return
			}

			userID, err := authSvc.ValidateAccessToken(token)
			if err != nil {
				authLog.Debug("invalid or expired token", zap.String("path", r.URL.Path))
				http.Error(w, `{"code":"UNAUTHORIZED","message":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), UserIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetUserID(ctx context.Context) string {
	v, _ := ctx.Value(UserIDKey).(string)
	return v
}
