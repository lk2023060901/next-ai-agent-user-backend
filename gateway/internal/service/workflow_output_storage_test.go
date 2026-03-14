package service

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/nextai-agent/gateway/internal/store"
)

func TestWorkflowOutputStorageMaterializeDataURL(t *testing.T) {
	client := &stubWorkflowOutputObjectStore{}
	svc := &WorkflowOutputStorageService{store: client}

	output, err := svc.Materialize(context.Background(), store.WorkflowRunOutputInput{
		RunID:  "run_1",
		NodeID: "node_1",
		PinID:  "audio",
		Kind:   "audio",
		Value: map[string]interface{}{
			"type":     "audio",
			"fileName": "clip.mp3",
			"mimeType": "audio/mpeg",
			"dataUrl":  "data:audio/mpeg;base64,aGVsbG8=",
		},
	})
	if err != nil {
		t.Fatalf("materialize output: %v", err)
	}

	if client.putKey == "" {
		t.Fatal("expected object store upload")
	}
	if string(client.putData) != "hello" {
		t.Fatalf("expected uploaded bytes, got %q", string(client.putData))
	}
	if output.StoragePath == nil || *output.StoragePath == "" {
		t.Fatalf("expected storage path, got %#v", output.StoragePath)
	}
	if output.SizeBytes == nil || *output.SizeBytes != 5 {
		t.Fatalf("expected size bytes, got %#v", output.SizeBytes)
	}
	value, ok := output.Value.(map[string]interface{})
	if !ok {
		t.Fatalf("expected sanitized map value, got %#v", output.Value)
	}
	if _, exists := value["dataUrl"]; exists {
		t.Fatalf("expected inline payload to be removed, got %#v", value)
	}
	if value["storagePath"] != *output.StoragePath {
		t.Fatalf("expected storage path in value, got %#v", value["storagePath"])
	}
}

func TestWorkflowOutputStorageOpen(t *testing.T) {
	client := &stubWorkflowOutputObjectStore{
		openContent: &WorkflowOutputContent{
			Body:        io.NopCloser(bytes.NewReader([]byte("content"))),
			ContentType: "audio/mpeg",
			SizeBytes:   7,
			FileName:    "clip.mp3",
		},
	}
	svc := &WorkflowOutputStorageService{store: client}

	content, err := svc.Open(context.Background(), "workflow-runs/run_1/node_1/audio/blob.mp3")
	if err != nil {
		t.Fatalf("open output content: %v", err)
	}
	defer content.Body.Close()

	body, err := io.ReadAll(content.Body)
	if err != nil {
		t.Fatalf("read output content: %v", err)
	}
	if string(body) != "content" {
		t.Fatalf("expected content body, got %q", string(body))
	}
}

type stubWorkflowOutputObjectStore struct {
	putKey      string
	putType     string
	putData     []byte
	openContent *WorkflowOutputContent
}

func (s *stubWorkflowOutputObjectStore) PutIfAbsent(_ context.Context, key string, contentType string, data []byte) error {
	s.putKey = key
	s.putType = contentType
	s.putData = append([]byte(nil), data...)
	return nil
}

func (s *stubWorkflowOutputObjectStore) Open(_ context.Context, _ string) (*WorkflowOutputContent, error) {
	return s.openContent, nil
}
