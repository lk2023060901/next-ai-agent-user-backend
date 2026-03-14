package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/service"
	"github.com/nextai-agent/gateway/internal/store"
)

func TestWorkflowRunHandlerCreateRunProxy(t *testing.T) {
	var seenAuthorization string
	var seenPath string
	var seenBody map[string]any
	var createdRecord *store.CreateWorkflowRunRecordInput

	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuthorization = r.Header.Get("Authorization")
		seenPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatalf("decode runtime request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"data":{"runId":"run_1","workflowId":"wf_1","workflowRevision":5,"status":"running"}}`))
	}))
	defer runtime.Close()

	router := chi.NewRouter()
	NewWorkflowRunHandler(runtime.URL, &stubWorkflowRunRecordStore{
		createFn: func(_ context.Context, input store.CreateWorkflowRunRecordInput) (*model.WorkflowRunRecord, error) {
			copied := input
			createdRecord = &copied
			now := time.Now().UTC()
			return &model.WorkflowRunRecord{
				RunID:      input.RunID,
				WorkflowID: input.WorkflowID,
				Status:     input.Status,
				StartedAt:  input.StartedAt,
				CreatedAt:  now,
				UpdatedAt:  now,
			}, nil
		},
		updateFn: func(_ context.Context, _ string, _ store.UpdateWorkflowRunRecordInput) error { return nil },
	}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodPost, "/workflows/wf_1/runs", strings.NewReader(`{"revision":5,"breakpoints":[{"nodeId":"n1","type":"before"}]}`))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	if seenPath != "/workflow/run" {
		t.Fatalf("expected runtime path /workflow/run, got %s", seenPath)
	}
	if seenAuthorization != "Bearer token" {
		t.Fatalf("expected authorization to be forwarded, got %q", seenAuthorization)
	}
	if seenBody["workflowId"] != "wf_1" {
		t.Fatalf("expected workflowId to be injected, got %#v", seenBody["workflowId"])
	}
	if seenBody["revision"] != float64(5) {
		t.Fatalf("expected revision to be forwarded, got %#v", seenBody["revision"])
	}
	if createdRecord == nil || createdRecord.RunID != "run_1" {
		t.Fatalf("expected workflow run record to be created, got %#v", createdRecord)
	}
}

func TestWorkflowRunHandlerRejectsDefinitionInput(t *testing.T) {
	router := chi.NewRouter()
	NewWorkflowRunHandler("http://127.0.0.1:3002", &stubWorkflowRunRecordStore{}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodPost, "/workflows/wf_1/runs", strings.NewReader(`{"definition":{"nodes":[],"connections":[]}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"definition 不是合法输入"`) {
		t.Fatalf("expected definition validation error, got %s", rec.Body.String())
	}
}

func TestWorkflowRunHandlerGetRunProxy(t *testing.T) {
	var seenPath string

	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"runId":"run_1","workflowId":"wf_1","status":"paused"}}`))
	}))
	defer runtime.Close()

	router := chi.NewRouter()
	NewWorkflowRunHandler(runtime.URL, &stubWorkflowRunRecordStore{}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodGet, "/workflow-runs/run_1", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if seenPath != "/workflow/run/run_1" {
		t.Fatalf("expected runtime path /workflow/run/run_1, got %s", seenPath)
	}
}

func TestWorkflowRunHandlerListRecords(t *testing.T) {
	router := chi.NewRouter()
	NewWorkflowRunHandler("http://127.0.0.1:3002", &stubWorkflowRunRecordStore{
		listFn: func(_ context.Context, workflowID string, limit int) ([]model.WorkflowRunRecord, error) {
			if workflowID != "wf_1" || limit != 25 {
				t.Fatalf("unexpected list args: workflowID=%s limit=%d", workflowID, limit)
			}
			now := time.Now().UTC()
			return []model.WorkflowRunRecord{{
				RunID:      "run_1",
				WorkflowID: workflowID,
				Status:     "completed",
				StartedAt:  now,
				CreatedAt:  now,
				UpdatedAt:  now,
			}}, nil
		},
	}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodGet, "/workflows/wf_1/runs?limit=25", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"runId":"run_1"`) {
		t.Fatalf("expected run record payload, got %s", rec.Body.String())
	}
}

func TestWorkflowRunHandlerGetRecord(t *testing.T) {
	router := chi.NewRouter()
	NewWorkflowRunHandler("http://127.0.0.1:3002", &stubWorkflowRunRecordStore{
		getFn: func(_ context.Context, runID string) (*model.WorkflowRunRecord, error) {
			now := time.Now().UTC()
			return &model.WorkflowRunRecord{
				RunID:      runID,
				WorkflowID: "wf_1",
				Status:     "failed",
				StartedAt:  now,
				CreatedAt:  now,
				UpdatedAt:  now,
			}, nil
		},
	}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodGet, "/workflow-runs/run_1/record", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"status":"failed"`) {
		t.Fatalf("expected persisted record payload, got %s", rec.Body.String())
	}
}

func TestWorkflowRunHandlerGetOutputs(t *testing.T) {
	router := chi.NewRouter()
	NewWorkflowRunHandler("http://127.0.0.1:3002", &stubWorkflowRunRecordStore{
		listOutputsFn: func(_ context.Context, runID string) ([]model.WorkflowRunOutput, error) {
			now := time.Now().UTC()
			return []model.WorkflowRunOutput{{
				ID:        "out_1",
				RunID:     runID,
				NodeID:    "n1",
				PinID:     "text",
				Kind:      "text",
				Value:     "hello",
				CreatedAt: now,
				UpdatedAt: now,
			}}, nil
		},
	}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodGet, "/workflow-runs/run_1/outputs", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"kind":"text"`) || !strings.Contains(rec.Body.String(), `"value":"hello"`) {
		t.Fatalf("expected output payload, got %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"contentUrl":"/api/workflow-runs/run_1/outputs/out_1/content"`) {
		t.Fatalf("expected content url in payload, got %s", rec.Body.String())
	}
}

func TestWorkflowRunHandlerGetOutputContentFromStorage(t *testing.T) {
	router := chi.NewRouter()
	NewWorkflowRunHandler("http://127.0.0.1:3002", &stubWorkflowRunRecordStore{
		getOutputFn: func(_ context.Context, runID string, outputID string) (*model.WorkflowRunOutput, error) {
			now := time.Now().UTC()
			return &model.WorkflowRunOutput{
				ID:          outputID,
				RunID:       runID,
				NodeID:      "n1",
				PinID:       "audio",
				Kind:        "audio",
				MimeType:    stringRef("audio/mpeg"),
				StoragePath: stringRef("workflow-runs/run_1/n1/audio/blob.mp3"),
				FileName:    stringRef("clip.mp3"),
				CreatedAt:   now,
				UpdatedAt:   now,
			}, nil
		},
	}, &stubWorkflowOutputStorage{
		openFn: func(_ context.Context, storagePath string) (*service.WorkflowOutputContent, error) {
			if storagePath != "workflow-runs/run_1/n1/audio/blob.mp3" {
				t.Fatalf("unexpected storage path: %s", storagePath)
			}
			return &service.WorkflowOutputContent{
				Body:        io.NopCloser(bytes.NewReader([]byte("audio-content"))),
				ContentType: "audio/mpeg",
				SizeBytes:   int64(len("audio-content")),
				FileName:    "clip.mp3",
			}, nil
		},
	}).Mount(router)

	req := httptest.NewRequest(http.MethodGet, "/workflow-runs/run_1/outputs/out_1/content", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "audio-content" {
		t.Fatalf("expected blob body, got %q", rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "audio/mpeg" {
		t.Fatalf("expected audio content type, got %q", got)
	}
}

func TestWorkflowRunHandlerGetOutputContentFromValue(t *testing.T) {
	router := chi.NewRouter()
	NewWorkflowRunHandler("http://127.0.0.1:3002", &stubWorkflowRunRecordStore{
		getOutputFn: func(_ context.Context, runID string, outputID string) (*model.WorkflowRunOutput, error) {
			now := time.Now().UTC()
			return &model.WorkflowRunOutput{
				ID:        outputID,
				RunID:     runID,
				NodeID:    "n1",
				PinID:     "text",
				Kind:      "text",
				Value:     "hello",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}, nil).Mount(router)

	req := httptest.NewRequest(http.MethodGet, "/workflow-runs/run_1/outputs/out_1/content", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "hello" {
		t.Fatalf("expected text body, got %q", rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("expected text content type, got %q", got)
	}
}

type stubWorkflowRunRecordStore struct {
	createFn         func(context.Context, store.CreateWorkflowRunRecordInput) (*model.WorkflowRunRecord, error)
	updateFn         func(context.Context, string, store.UpdateWorkflowRunRecordInput) error
	listFn           func(context.Context, string, int) ([]model.WorkflowRunRecord, error)
	getFn            func(context.Context, string) (*model.WorkflowRunRecord, error)
	replaceOutputsFn func(context.Context, string, []store.WorkflowRunOutputInput) error
	listOutputsFn    func(context.Context, string) ([]model.WorkflowRunOutput, error)
	getOutputFn      func(context.Context, string, string) (*model.WorkflowRunOutput, error)
}

func (s *stubWorkflowRunRecordStore) Create(ctx context.Context, input store.CreateWorkflowRunRecordInput) (*model.WorkflowRunRecord, error) {
	if s.createFn != nil {
		return s.createFn(ctx, input)
	}
	now := time.Now().UTC()
	return &model.WorkflowRunRecord{
		RunID:      input.RunID,
		WorkflowID: input.WorkflowID,
		Status:     input.Status,
		StartedAt:  input.StartedAt,
		CreatedAt:  now,
		UpdatedAt:  now,
	}, nil
}

func (s *stubWorkflowRunRecordStore) UpdateState(ctx context.Context, runID string, input store.UpdateWorkflowRunRecordInput) error {
	if s.updateFn != nil {
		return s.updateFn(ctx, runID, input)
	}
	return nil
}

func (s *stubWorkflowRunRecordStore) ListByWorkflow(ctx context.Context, workflowID string, limit int) ([]model.WorkflowRunRecord, error) {
	if s.listFn != nil {
		return s.listFn(ctx, workflowID, limit)
	}
	return nil, nil
}

func (s *stubWorkflowRunRecordStore) GetByRunID(ctx context.Context, runID string) (*model.WorkflowRunRecord, error) {
	if s.getFn != nil {
		return s.getFn(ctx, runID)
	}
	return nil, store.ErrWorkflowRunRecordNotFound
}

func (s *stubWorkflowRunRecordStore) ReplaceOutputs(ctx context.Context, runID string, outputs []store.WorkflowRunOutputInput) error {
	if s.replaceOutputsFn != nil {
		return s.replaceOutputsFn(ctx, runID, outputs)
	}
	return nil
}

func (s *stubWorkflowRunRecordStore) ListOutputsByRunID(ctx context.Context, runID string) ([]model.WorkflowRunOutput, error) {
	if s.listOutputsFn != nil {
		return s.listOutputsFn(ctx, runID)
	}
	return []model.WorkflowRunOutput{}, nil
}

func (s *stubWorkflowRunRecordStore) GetOutputByID(ctx context.Context, runID string, outputID string) (*model.WorkflowRunOutput, error) {
	if s.getOutputFn != nil {
		return s.getOutputFn(ctx, runID, outputID)
	}
	return nil, store.ErrWorkflowRunOutputNotFound
}

type stubWorkflowOutputStorage struct {
	openFn func(context.Context, string) (*service.WorkflowOutputContent, error)
}

func (s *stubWorkflowOutputStorage) Materialize(_ context.Context, output store.WorkflowRunOutputInput) (store.WorkflowRunOutputInput, error) {
	return output, nil
}

func (s *stubWorkflowOutputStorage) Open(ctx context.Context, storagePath string) (*service.WorkflowOutputContent, error) {
	if s.openFn != nil {
		return s.openFn(ctx, storagePath)
	}
	return nil, nil
}

func stringRef(value string) *string {
	copyValue := value
	return &copyValue
}
