package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
)

const defaultGRPCTimeout = 15 * time.Second

// grpcCtx returns a context with a deadline for gRPC calls.
func grpcCtx(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), defaultGRPCTimeout)
}

var pj = protojson.MarshalOptions{
	UseProtoNames:   false, // camelCase
	EmitUnpopulated: false,
}

// writeJSON writes a plain Go value (map, struct) as JSON
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// writeProto writes a protobuf message as camelCase JSON wrapped in { data: ... }
func writeProto(w http.ResponseWriter, code int, msg proto.Message) {
	b, err := pj.Marshal(msg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "marshal error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	w.Write([]byte(`{"data":`))
	w.Write(b)
	w.Write([]byte(`}`))
}

// writeData wraps any value in { data: ... }
func writeData(w http.ResponseWriter, code int, v any) {
	writeJSON(w, code, map[string]any{"data": v})
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg, "code": "ERROR", "message": msg})
}

func writeGRPCError(w http.ResponseWriter, err error) {
	st, ok := status.FromError(err)
	if !ok {
		log.Printf("Internal error: %v", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	httpCode := grpcCodeToHTTP(st.Code())
	writeJSON(w, httpCode, map[string]string{
		"error":   st.Message(),
		"code":    st.Code().String(),
		"message": st.Message(),
	})
}

func grpcCodeToHTTP(code codes.Code) int {
	switch code {
	case codes.NotFound:
		return http.StatusNotFound
	case codes.AlreadyExists:
		return http.StatusConflict
	case codes.InvalidArgument:
		return http.StatusBadRequest
	case codes.Unauthenticated:
		return http.StatusUnauthorized
	case codes.PermissionDenied:
		return http.StatusForbidden
	case codes.ResourceExhausted:
		return http.StatusTooManyRequests
	case codes.Unimplemented:
		return http.StatusNotImplemented
	case codes.Canceled:
		return 499
	case codes.DeadlineExceeded:
		return http.StatusGatewayTimeout
	case codes.Unavailable:
		return http.StatusServiceUnavailable
	case codes.FailedPrecondition:
		return http.StatusPreconditionFailed
	default:
		return http.StatusInternalServerError
	}
}

// userCtxFromRequest extracts a UserContext from the request's JWT claims.
// Returns nil if no authenticated user is found.
func userCtxFromRequest(r *http.Request) *commonpb.UserContext {
	u, ok := middleware.GetUser(r)
	if !ok {
		return nil
	}
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}
