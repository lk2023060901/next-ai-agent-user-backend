package handler

import (
	"encoding/json"
	"net/http"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

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
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpCode := grpcCodeToHTTP(st.Code())
	writeError(w, httpCode, st.Message())
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
	default:
		return http.StatusInternalServerError
	}
}
