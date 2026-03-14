package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/nextai-agent/gateway/internal/config"
	"github.com/nextai-agent/gateway/internal/store"
)

type WorkflowOutputStorage interface {
	Materialize(ctx context.Context, output store.WorkflowRunOutputInput) (store.WorkflowRunOutputInput, error)
	Open(ctx context.Context, storagePath string) (*WorkflowOutputContent, error)
}

type WorkflowOutputContent struct {
	Body        io.ReadCloser
	ContentType string
	SizeBytes   int64
	FileName    string
}

type workflowOutputObjectStore interface {
	PutIfAbsent(ctx context.Context, key string, contentType string, data []byte) error
	Open(ctx context.Context, key string) (*WorkflowOutputContent, error)
}

type WorkflowOutputStorageService struct {
	store workflowOutputObjectStore
}

func NewWorkflowOutputStorage(ctx context.Context, cfg config.WorkflowOutputStorageConfig) (WorkflowOutputStorage, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" || strings.TrimSpace(cfg.Bucket) == "" {
		return nil, nil
	}

	client, err := newMinioWorkflowOutputObjectStore(ctx, cfg)
	if err != nil {
		return nil, err
	}

	return &WorkflowOutputStorageService{store: client}, nil
}

func (s *WorkflowOutputStorageService) Materialize(ctx context.Context, output store.WorkflowRunOutputInput) (store.WorkflowRunOutputInput, error) {
	if s == nil || s.store == nil {
		return output, nil
	}

	value, ok := output.Value.(map[string]interface{})
	if !ok {
		return output, nil
	}
	if output.StoragePath != nil && strings.TrimSpace(*output.StoragePath) != "" {
		return output, nil
	}

	payload, ok, err := extractInlineWorkflowOutputPayload(value, output.MimeType)
	if err != nil || !ok {
		return output, err
	}

	contentType := strings.TrimSpace(payload.mimeType)
	if contentType == "" {
		contentType = http.DetectContentType(payload.data)
	}

	fileName := payload.fileName
	if strings.TrimSpace(fileName) == "" {
		fileName = defaultWorkflowOutputFileName(output.NodeID, output.PinID, output.Kind, contentType)
	}

	key := workflowOutputStorageKey(output.RunID, output.NodeID, output.PinID, payload.data, fileName, contentType)
	if err := s.store.PutIfAbsent(ctx, key, contentType, payload.data); err != nil {
		return output, err
	}

	sanitized := cloneStringAnyMap(value)
	for _, field := range payload.inlineFields {
		delete(sanitized, field)
	}
	sanitized["storagePath"] = key
	sanitized["sizeBytes"] = int64(len(payload.data))
	if strings.TrimSpace(contentType) != "" {
		sanitized["mimeType"] = contentType
	}
	if strings.TrimSpace(fileName) != "" {
		sanitized["fileName"] = fileName
	}

	output.Value = sanitized
	output.StoragePath = stringPointer(key)
	output.SizeBytes = int64Pointer(int64(len(payload.data)))
	if strings.TrimSpace(contentType) != "" {
		output.MimeType = stringPointer(contentType)
	}
	if strings.TrimSpace(fileName) != "" {
		output.FileName = stringPointer(fileName)
	}
	return output, nil
}

func (s *WorkflowOutputStorageService) Open(ctx context.Context, storagePath string) (*WorkflowOutputContent, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("workflow output storage is not configured")
	}
	return s.store.Open(ctx, storagePath)
}

type minioWorkflowOutputObjectStore struct {
	client *minio.Client
	bucket string
}

func newMinioWorkflowOutputObjectStore(ctx context.Context, cfg config.WorkflowOutputStorageConfig) (*minioWorkflowOutputObjectStore, error) {
	endpoint, secure, err := parseWorkflowOutputStorageEndpoint(cfg.Endpoint, cfg.UseSSL)
	if err != nil {
		return nil, err
	}

	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: secure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("create workflow output object store client: %w", err)
	}

	if err := ensureWorkflowOutputBucket(ctx, client, cfg); err != nil {
		return nil, err
	}

	return &minioWorkflowOutputObjectStore{
		client: client,
		bucket: cfg.Bucket,
	}, nil
}

func ensureWorkflowOutputBucket(ctx context.Context, client *minio.Client, cfg config.WorkflowOutputStorageConfig) error {
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return fmt.Errorf("check workflow output bucket: %w", err)
	}
	if exists {
		return nil
	}
	if !cfg.AutoCreateBucket {
		return fmt.Errorf("workflow output bucket %q does not exist", cfg.Bucket)
	}
	if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
		resp := minio.ToErrorResponse(err)
		if resp.Code != "BucketAlreadyOwnedByYou" && resp.Code != "BucketAlreadyExists" {
			return fmt.Errorf("create workflow output bucket: %w", err)
		}
	}
	return nil
}

func (s *minioWorkflowOutputObjectStore) PutIfAbsent(ctx context.Context, key string, contentType string, data []byte) error {
	_, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err == nil {
		return nil
	}

	resp := minio.ToErrorResponse(err)
	if resp.Code != "NoSuchKey" && resp.Code != "NoSuchObject" && resp.Code != "NoSuchBucket" {
		return fmt.Errorf("stat workflow output object: %w", err)
	}

	_, err = s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return fmt.Errorf("put workflow output object: %w", err)
	}
	return nil
}

func (s *minioWorkflowOutputObjectStore) Open(ctx context.Context, key string) (*WorkflowOutputContent, error) {
	object, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("open workflow output object: %w", err)
	}

	info, err := object.Stat()
	if err != nil {
		object.Close()
		return nil, fmt.Errorf("stat workflow output object: %w", err)
	}

	return &WorkflowOutputContent{
		Body:        object,
		ContentType: info.ContentType,
		SizeBytes:   info.Size,
	}, nil
}

type inlineWorkflowOutputPayload struct {
	data         []byte
	mimeType     string
	fileName     string
	inlineFields []string
}

func extractInlineWorkflowOutputPayload(value map[string]interface{}, outputMimeType *string) (*inlineWorkflowOutputPayload, bool, error) {
	fileName := readWorkflowOutputString(value, "fileName", "filename", "name")
	if dataURL := readWorkflowOutputString(value, "dataUrl", "dataURL", "contentDataUrl", "contentDataURL"); dataURL != "" {
		payload, err := decodeWorkflowOutputDataURL(dataURL)
		if err != nil {
			return nil, false, err
		}
		if strings.TrimSpace(fileName) == "" {
			fileName = readWorkflowOutputString(value, "fileName", "filename", "name")
		}
		return &inlineWorkflowOutputPayload{
			data:         payload.data,
			mimeType:     firstNonEmpty(payload.mimeType, readWorkflowOutputString(value, "mimeType", "mime_type"), derefString(outputMimeType)),
			fileName:     fileName,
			inlineFields: []string{"dataUrl", "dataURL", "contentDataUrl", "contentDataURL"},
		}, true, nil
	}

	base64Value := readWorkflowOutputString(value, "contentBase64", "base64", "dataBase64", "bytesBase64")
	if strings.TrimSpace(base64Value) != "" {
		data, err := decodeWorkflowOutputBase64(base64Value)
		if err != nil {
			return nil, false, err
		}
		return &inlineWorkflowOutputPayload{
			data:         data,
			mimeType:     firstNonEmpty(readWorkflowOutputString(value, "mimeType", "mime_type"), derefString(outputMimeType)),
			fileName:     fileName,
			inlineFields: []string{"contentBase64", "base64", "dataBase64", "bytesBase64"},
		}, true, nil
	}

	content := readWorkflowOutputString(value, "content")
	if strings.HasPrefix(strings.TrimSpace(content), "data:") {
		payload, err := decodeWorkflowOutputDataURL(content)
		if err != nil {
			return nil, false, err
		}
		return &inlineWorkflowOutputPayload{
			data:         payload.data,
			mimeType:     firstNonEmpty(payload.mimeType, readWorkflowOutputString(value, "mimeType", "mime_type"), derefString(outputMimeType)),
			fileName:     fileName,
			inlineFields: []string{"content"},
		}, true, nil
	}

	return nil, false, nil
}

type decodedWorkflowOutputDataURL struct {
	data     []byte
	mimeType string
}

func decodeWorkflowOutputDataURL(raw string) (*decodedWorkflowOutputDataURL, error) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "data:") {
		return nil, errors.New("workflow output data url is invalid")
	}

	comma := strings.Index(trimmed, ",")
	if comma < 0 {
		return nil, errors.New("workflow output data url is invalid")
	}

	meta := trimmed[5:comma]
	body := trimmed[comma+1:]
	mimeType := ""
	isBase64 := false

	if meta != "" {
		parts := strings.Split(meta, ";")
		if len(parts) > 0 && parts[0] != "" {
			mimeType = parts[0]
		}
		for _, part := range parts[1:] {
			if strings.EqualFold(strings.TrimSpace(part), "base64") {
				isBase64 = true
				break
			}
		}
	}

	if isBase64 {
		data, err := decodeWorkflowOutputBase64(body)
		if err != nil {
			return nil, err
		}
		return &decodedWorkflowOutputDataURL{data: data, mimeType: mimeType}, nil
	}

	decoded, err := url.PathUnescape(body)
	if err != nil {
		return nil, err
	}
	return &decodedWorkflowOutputDataURL{data: []byte(decoded), mimeType: mimeType}, nil
}

func decodeWorkflowOutputBase64(raw string) ([]byte, error) {
	cleaned := strings.TrimSpace(raw)
	if cleaned == "" {
		return nil, errors.New("workflow output base64 content is empty")
	}
	cleaned = strings.ReplaceAll(cleaned, "\n", "")
	cleaned = strings.ReplaceAll(cleaned, "\r", "")
	cleaned = strings.ReplaceAll(cleaned, " ", "")

	data, err := base64.StdEncoding.DecodeString(cleaned)
	if err == nil {
		return data, nil
	}
	data, rawErr := base64.RawStdEncoding.DecodeString(cleaned)
	if rawErr == nil {
		return data, nil
	}
	return nil, err
}

func workflowOutputStorageKey(runID string, nodeID string, pinID string, data []byte, fileName string, contentType string) string {
	sum := sha256.Sum256(data)
	extension := strings.ToLower(strings.TrimSpace(filepath.Ext(fileName)))
	if extension == "" && strings.TrimSpace(contentType) != "" {
		if exts, err := mime.ExtensionsByType(contentType); err == nil && len(exts) > 0 {
			extension = exts[0]
		}
	}
	return strings.Join([]string{
		"workflow-runs",
		sanitizeWorkflowOutputSegment(runID),
		sanitizeWorkflowOutputSegment(nodeID),
		sanitizeWorkflowOutputSegment(pinID),
		hex.EncodeToString(sum[:]) + extension,
	}, "/")
}

func defaultWorkflowOutputFileName(nodeID string, pinID string, kind string, contentType string) string {
	base := sanitizeWorkflowOutputSegment(firstNonEmpty(pinID, nodeID, kind, "output"))
	extension := ""
	if strings.TrimSpace(contentType) != "" {
		if exts, err := mime.ExtensionsByType(contentType); err == nil && len(exts) > 0 {
			extension = exts[0]
		}
	}
	return base + extension
}

func sanitizeWorkflowOutputSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}

	var builder strings.Builder
	for _, ch := range value {
		switch {
		case ch >= 'a' && ch <= 'z':
			builder.WriteRune(ch)
		case ch >= 'A' && ch <= 'Z':
			builder.WriteRune(ch)
		case ch >= '0' && ch <= '9':
			builder.WriteRune(ch)
		case ch == '-' || ch == '_' || ch == '.':
			builder.WriteRune(ch)
		default:
			builder.WriteRune('_')
		}
	}
	return builder.String()
}

func parseWorkflowOutputStorageEndpoint(raw string, secure bool) (string, bool, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", secure, errors.New("workflow output storage endpoint is required")
	}
	if strings.Contains(trimmed, "://") {
		parsed, err := url.Parse(trimmed)
		if err != nil {
			return "", secure, err
		}
		return parsed.Host, strings.EqualFold(parsed.Scheme, "https"), nil
	}
	return trimmed, secure, nil
}

func cloneStringAnyMap(value map[string]interface{}) map[string]interface{} {
	cloned := make(map[string]interface{}, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func readWorkflowOutputString(value map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		raw, ok := value[key]
		if !ok {
			continue
		}
		str, ok := raw.(string)
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(str); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func stringPointer(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	copyValue := value
	return &copyValue
}

func int64Pointer(value int64) *int64 {
	copyValue := value
	return &copyValue
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
