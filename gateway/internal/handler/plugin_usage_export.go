package handler

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	pluginUsageSpecVersion = "plugin-usage.v1"
	defaultPluginName      = "runtime.core"
	defaultPluginVersion   = "1.0.0"
)

var pluginUsageReservedMetadataKeys = map[string]struct{}{
	"pluginName":    {},
	"pluginVersion": {},
	"eventType":     {},
	"status":        {},
	"metrics":       {},
	"payload":       {},
}

type pluginUsageSourceRecord struct {
	ID           string
	WorkspaceID  string
	OrgID        string
	SessionID    string
	RunID        string
	TaskID       string
	RecordType   string
	Scope        string
	Status       string
	AgentID      string
	AgentName    string
	AgentRole    string
	Provider     string
	Model        string
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
	SuccessCount int64
	FailureCount int64
	DurationMs   int64
	Cost         float64
	Timestamp    string
	MetadataJSON string
}

func isPluginJSONFormat(format string) bool {
	normalized := strings.TrimSpace(strings.ToLower(format))
	return normalized == "plugin_json" || normalized == "plugin-json"
}

func isPluginNDJSONFormat(format string) bool {
	normalized := strings.TrimSpace(strings.ToLower(format))
	return normalized == "plugin_ndjson" || normalized == "plugin-ndjson" || normalized == "ndjson"
}

func parseMetadataJSON(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}

	var out map[string]any
	if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
		return nil
	}
	return out
}

func toStringValue(value any) string {
	if value == nil {
		return ""
	}

	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case fmt.Stringer:
		return strings.TrimSpace(v.String())
	case float64:
		if math.Mod(v, 1) == 0 {
			return fmt.Sprintf("%.0f", v)
		}
		return strings.TrimSpace(fmt.Sprintf("%v", v))
	case int, int8, int16, int32, int64:
		return strings.TrimSpace(fmt.Sprintf("%d", v))
	case uint, uint8, uint16, uint32, uint64:
		return strings.TrimSpace(fmt.Sprintf("%d", v))
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", value))
	}
}

func toInt64Value(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int8:
		return int64(v), true
	case int16:
		return int64(v), true
	case int32:
		return int64(v), true
	case int64:
		return v, true
	case uint:
		return int64(v), true
	case uint8:
		return int64(v), true
	case uint16:
		return int64(v), true
	case uint32:
		return int64(v), true
	case uint64:
		if v > math.MaxInt64 {
			return 0, false
		}
		return int64(v), true
	case float64:
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			return int64(v), true
		}
	case float32:
		f := float64(v)
		if !math.IsNaN(f) && !math.IsInf(f, 0) {
			return int64(f), true
		}
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return i, true
		}
		if f, err := v.Float64(); err == nil {
			return int64(f), true
		}
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, false
		}
		if i, err := json.Number(trimmed).Int64(); err == nil {
			return i, true
		}
		if f, err := json.Number(trimmed).Float64(); err == nil {
			return int64(f), true
		}
	}
	return 0, false
}

func toFloat64Value(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			return v, true
		}
	case float32:
		f := float64(v)
		if !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, true
		}
	case int:
		return float64(v), true
	case int8:
		return float64(v), true
	case int16:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case uint:
		return float64(v), true
	case uint8:
		return float64(v), true
	case uint16:
		return float64(v), true
	case uint32:
		return float64(v), true
	case uint64:
		return float64(v), true
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return f, true
		}
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, false
		}
		if f, err := json.Number(trimmed).Float64(); err == nil {
			return f, true
		}
	}
	return 0, false
}

func toStringMap(value any) map[string]any {
	if value == nil {
		return nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return m
}

func buildPluginUsageEvent(src pluginUsageSourceRecord) map[string]any {
	metadata := parseMetadataJSON(src.MetadataJSON)
	if metadata == nil {
		metadata = map[string]any{}
	}

	pluginName := toStringValue(metadata["pluginName"])
	if pluginName == "" {
		pluginName = defaultPluginName
	}

	pluginVersion := toStringValue(metadata["pluginVersion"])
	if pluginVersion == "" {
		pluginVersion = defaultPluginVersion
	}

	eventType := toStringValue(metadata["eventType"])
	if eventType == "" {
		eventType = fmt.Sprintf("usage.%s.%s", strings.TrimSpace(src.RecordType), strings.TrimSpace(src.Scope))
	}

	status := strings.TrimSpace(strings.ToLower(src.Status))
	if override := toStringValue(metadata["status"]); override != "" {
		status = strings.ToLower(override)
	}
	if status == "" {
		status = "unknown"
	}

	eventID := strings.TrimSpace(src.ID)
	if eventID == "" {
		eventID = fmt.Sprintf("usage-%d", time.Now().UnixNano())
	}

	timestamp := strings.TrimSpace(src.Timestamp)
	if timestamp == "" {
		timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	metrics := map[string]any{}
	if src.InputTokens > 0 {
		metrics["inputTokens"] = src.InputTokens
	}
	if src.OutputTokens > 0 {
		metrics["outputTokens"] = src.OutputTokens
	}
	if src.DurationMs > 0 {
		metrics["latencyMs"] = src.DurationMs
	}
	if src.SuccessCount > 0 {
		metrics["successCount"] = src.SuccessCount
	}
	if src.FailureCount > 0 {
		metrics["failureCount"] = src.FailureCount
	}
	if src.Cost > 0 {
		metrics["cost"] = src.Cost
	}
	if overrideMetrics := toStringMap(metadata["metrics"]); overrideMetrics != nil {
		for key, value := range overrideMetrics {
			switch key {
			case "inputTokens", "outputTokens", "latencyMs", "successCount", "failureCount":
				if n, ok := toInt64Value(value); ok {
					metrics[key] = n
					continue
				}
			case "cost":
				if n, ok := toFloat64Value(value); ok {
					metrics[key] = n
					continue
				}
			}
			metrics[key] = value
		}
	}

	payload := map[string]any{
		"orgId":       src.OrgID,
		"sessionId":   src.SessionID,
		"taskId":      src.TaskID,
		"recordType":  src.RecordType,
		"scope":       src.Scope,
		"agentId":     src.AgentID,
		"agentName":   src.AgentName,
		"agentRole":   src.AgentRole,
		"provider":    src.Provider,
		"model":       src.Model,
		"totalTokens": src.TotalTokens,
	}
	if overridePayload := toStringMap(metadata["payload"]); overridePayload != nil {
		for key, value := range overridePayload {
			payload[key] = value
		}
	}
	for key, value := range metadata {
		if _, reserved := pluginUsageReservedMetadataKeys[key]; reserved {
			continue
		}
		payload[key] = value
	}

	return map[string]any{
		"specVersion":   pluginUsageSpecVersion,
		"pluginName":    pluginName,
		"pluginVersion": pluginVersion,
		"eventId":       eventID,
		"eventType":     eventType,
		"timestamp":     timestamp,
		"workspaceId":   src.WorkspaceID,
		"runId":         src.RunID,
		"status":        status,
		"metrics":       metrics,
		"payload":       payload,
	}
}
