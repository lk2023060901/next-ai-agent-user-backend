package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

var ErrWorkflowRunOutputNotFound = errors.New("workflow run output not found")

var workflowRunOutputColumns = []string{
	"id", "run_id", "node_id", "pin_id", "kind", "value_json", "mime_type",
	"media_url", "storage_path", "file_name", "size_bytes", "created_at", "updated_at",
}

type WorkflowRunOutputInput struct {
	RunID       string
	NodeID      string
	PinID       string
	Kind        string
	Value       interface{}
	MimeType    *string
	MediaURL    *string
	StoragePath *string
	FileName    *string
	SizeBytes   *int64
}

func (s *WorkflowRunStore) ReplaceOutputs(ctx context.Context, runID string, outputs []WorkflowRunOutputInput) error {
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin replace workflow run outputs tx: %w", err)
	}
	defer tx.Rollback(ctx)

	sql, args, err := Delete("workflow_run_outputs").Where("run_id = ?", runID).ToSql()
	if err != nil {
		return fmt.Errorf("build delete workflow run outputs sql: %w", err)
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("delete workflow run outputs: %w", err)
	}

	sort.Slice(outputs, func(i, j int) bool {
		if outputs[i].NodeID == outputs[j].NodeID {
			return outputs[i].PinID < outputs[j].PinID
		}
		return outputs[i].NodeID < outputs[j].NodeID
	})

	for _, output := range outputs {
		valueJSON, err := json.Marshal(output.Value)
		if err != nil {
			return fmt.Errorf("marshal workflow run output value: %w", err)
		}
		sql, args, err := Insert("workflow_run_outputs").
			Columns(
				"run_id", "node_id", "pin_id", "kind", "value_json", "mime_type",
				"media_url", "storage_path", "file_name", "size_bytes",
			).
			Values(
				output.RunID, output.NodeID, output.PinID, output.Kind, valueJSON,
				output.MimeType, output.MediaURL, output.StoragePath, output.FileName, output.SizeBytes,
			).
			ToSql()
		if err != nil {
			return fmt.Errorf("build insert workflow run output sql: %w", err)
		}
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			return fmt.Errorf("insert workflow run output: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit replace workflow run outputs tx: %w", err)
	}
	return nil
}

func (s *WorkflowRunStore) ListOutputsByRunID(ctx context.Context, runID string) ([]model.WorkflowRunOutput, error) {
	rows, err := s.db.Query(ctx,
		Select(workflowRunOutputColumns...).
			From("workflow_run_outputs").
			Where("run_id = ?", runID).
			OrderBy("node_id ASC", "pin_id ASC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list workflow run outputs: %w", err)
	}
	defer rows.Close()
	return scanWorkflowRunOutputs(rows)
}

func (s *WorkflowRunStore) GetOutputByID(ctx context.Context, runID string, outputID string) (*model.WorkflowRunOutput, error) {
	rows, err := s.db.Query(ctx,
		Select(workflowRunOutputColumns...).
			From("workflow_run_outputs").
			Where("run_id = ?", runID).
			Where("id = ?", outputID).
			Limit(1),
	)
	if err != nil {
		return nil, fmt.Errorf("get workflow run output: %w", err)
	}
	defer rows.Close()

	outputs, err := scanWorkflowRunOutputs(rows)
	if err != nil {
		return nil, err
	}
	if len(outputs) == 0 {
		return nil, ErrWorkflowRunOutputNotFound
	}
	return &outputs[0], nil
}

func NormalizeWorkflowRunOutput(runID string, nodeID string, pinID string, value interface{}) WorkflowRunOutputInput {
	output := WorkflowRunOutputInput{
		RunID:  runID,
		NodeID: nodeID,
		PinID:  pinID,
		Value:  value,
		Kind:   classifyWorkflowRunOutputKind(value),
	}

	if media, ok := value.(map[string]interface{}); ok {
		output.MimeType = readStringField(media, "mimeType", "mime_type")
		output.MediaURL = readStringField(media, "url", "uri", "mediaUrl", "media_url")
		output.StoragePath = readStringField(media, "storagePath", "storage_path", "path")
		output.FileName = readStringField(media, "fileName", "filename", "name")
		output.SizeBytes = readInt64Field(media, "sizeBytes", "size_bytes", "size")

		// If a structured media-like payload exists, keep the more specific kind.
		if output.Kind == "json" && output.MimeType != nil {
			lower := strings.ToLower(*output.MimeType)
			switch {
			case strings.HasPrefix(lower, "audio/"):
				output.Kind = "audio"
			case strings.HasPrefix(lower, "video/"):
				output.Kind = "video"
			case strings.HasPrefix(lower, "image/"):
				output.Kind = "image"
			}
		}
	}

	return output
}

func scanWorkflowRunOutputs(rows pgx.Rows) ([]model.WorkflowRunOutput, error) {
	var outputs []model.WorkflowRunOutput
	for rows.Next() {
		var (
			output    model.WorkflowRunOutput
			valueJSON []byte
		)
		if err := rows.Scan(
			&output.ID, &output.RunID, &output.NodeID, &output.PinID, &output.Kind, &valueJSON, &output.MimeType,
			&output.MediaURL, &output.StoragePath, &output.FileName, &output.SizeBytes, &output.CreatedAt, &output.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan workflow run output: %w", err)
		}
		if err := json.Unmarshal(valueJSON, &output.Value); err != nil {
			return nil, fmt.Errorf("decode workflow run output value: %w", err)
		}
		outputs = append(outputs, output)
	}
	if outputs == nil {
		outputs = []model.WorkflowRunOutput{}
	}
	return outputs, nil
}

func classifyWorkflowRunOutputKind(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return "text"
	case bool:
		return "boolean"
	case float64, float32, int, int32, int64, uint, uint32, uint64:
		return "number"
	case map[string]interface{}:
		if mediaKind := readStringField(typed, "kind", "type", "mediaType", "media_type"); mediaKind != nil {
			switch strings.ToLower(*mediaKind) {
			case "audio", "video", "image", "file":
				return strings.ToLower(*mediaKind)
			}
		}
		if mimeType := readStringField(typed, "mimeType", "mime_type"); mimeType != nil {
			lower := strings.ToLower(*mimeType)
			switch {
			case strings.HasPrefix(lower, "audio/"):
				return "audio"
			case strings.HasPrefix(lower, "video/"):
				return "video"
			case strings.HasPrefix(lower, "image/"):
				return "image"
			}
		}
		return "json"
	default:
		return "json"
	}
}

func readStringField(value map[string]interface{}, keys ...string) *string {
	for _, key := range keys {
		raw, ok := value[key]
		if !ok {
			continue
		}
		if str, ok := raw.(string); ok && strings.TrimSpace(str) != "" {
			trimmed := strings.TrimSpace(str)
			return &trimmed
		}
	}
	return nil
}

func readInt64Field(value map[string]interface{}, keys ...string) *int64 {
	for _, key := range keys {
		raw, ok := value[key]
		if !ok {
			continue
		}
		switch typed := raw.(type) {
		case float64:
			converted := int64(typed)
			return &converted
		case int64:
			return &typed
		case int:
			converted := int64(typed)
			return &converted
		}
	}
	return nil
}
