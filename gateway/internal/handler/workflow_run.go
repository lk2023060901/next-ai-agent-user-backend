package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/middleware"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/service"
	"github.com/nextai-agent/gateway/internal/store"
)

var workflowRunLog = logger.Named("workflow-run")

type workflowRunRecordStore interface {
	Create(ctx context.Context, input store.CreateWorkflowRunRecordInput) (*model.WorkflowRunRecord, error)
	UpdateState(ctx context.Context, runID string, input store.UpdateWorkflowRunRecordInput) error
	ListByWorkflow(ctx context.Context, workflowID string, limit int) ([]model.WorkflowRunRecord, error)
	GetByRunID(ctx context.Context, runID string) (*model.WorkflowRunRecord, error)
	ReplaceOutputs(ctx context.Context, runID string, outputs []store.WorkflowRunOutputInput) error
	ListOutputsByRunID(ctx context.Context, runID string) ([]model.WorkflowRunOutput, error)
	GetOutputByID(ctx context.Context, runID string, outputID string) (*model.WorkflowRunOutput, error)
}

type WorkflowRunHandler struct {
	runtimeBaseURL string
	client         *http.Client
	records        workflowRunRecordStore
	outputStorage  service.WorkflowOutputStorage
}

type runtimeRunEnvelope struct {
	Data runtimeRunState `json:"data"`
}

type runtimeRunState struct {
	RunID                string                      `json:"runId"`
	WorkflowID           string                      `json:"workflowId"`
	WorkflowRevision     *int                        `json:"workflowRevision,omitempty"`
	Status               string                      `json:"status"`
	CurrentNodeID        *string                     `json:"currentNodeId"`
	FailedNodeID         *string                     `json:"failedNodeId"`
	PausedAtNodeID       *string                     `json:"pausedAtNodeId"`
	PausedBreakpointType *string                     `json:"pausedBreakpointType"`
	ErrorMessage         *string                     `json:"errorMessage"`
	NodeStates           map[string]runtimeNodeState `json:"nodeStates"`
	StartedAt            int64                       `json:"startedAt"`
	CompletedAt          *int64                      `json:"completedAt,omitempty"`
}

type runtimeNodeState struct {
	Outputs []runtimePinValue `json:"outputs"`
}

type runtimePinValue struct {
	PinID string      `json:"pinId"`
	Value interface{} `json:"value"`
}

func NewWorkflowRunHandler(runtimeBaseURL string, records workflowRunRecordStore, outputStorage service.WorkflowOutputStorage) *WorkflowRunHandler {
	return &WorkflowRunHandler{
		runtimeBaseURL: strings.TrimRight(runtimeBaseURL, "/"),
		client:         &http.Client{},
		records:        records,
		outputStorage:  outputStorage,
	}
}

func (h *WorkflowRunHandler) Mount(r chi.Router) {
	r.Get("/workflows/{workflowId}/runs", h.ListRecords)
	r.Post("/workflows/{workflowId}/runs", h.CreateRun)
	r.Get("/workflow-runs/{runId}", h.GetRun)
	r.Get("/workflow-runs/{runId}/record", h.GetRecord)
	r.Get("/workflow-runs/{runId}/outputs", h.GetOutputs)
	r.Get("/workflow-runs/{runId}/outputs/{outputId}/content", h.GetOutputContent)
	r.Get("/workflow-runs/{runId}/state", h.GetRunState)
	r.Post("/workflow-runs/{runId}/resume", h.ResumeRun)
	r.Post("/workflow-runs/{runId}/step", h.StepRun)
	r.Post("/workflow-runs/{runId}/abort", h.AbortRun)
	r.Get("/workflow-runs/{runId}/events", h.RunEvents)
}

func (h *WorkflowRunHandler) ListRecords(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid limit")
			return
		}
		limit = parsed
	}

	records, err := h.records.ListByWorkflow(r.Context(), workflowID, limit)
	if err != nil {
		workflowRunLog.Error("list workflow run records failed", zap.String("workflowId", workflowID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 workflow 执行记录失败")
		return
	}
	if records == nil {
		records = []model.WorkflowRunRecord{}
	}
	writeData(w, records)
}

func (h *WorkflowRunHandler) GetRecord(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	record, err := h.records.GetByRunID(r.Context(), runID)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrWorkflowRunRecordNotFound):
			writeError(w, http.StatusNotFound, "NOT_FOUND", "workflow 执行记录不存在")
		default:
			workflowRunLog.Error("get workflow run record failed", zap.String("runId", runID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 workflow 执行记录失败")
		}
		return
	}
	writeData(w, record)
}

func (h *WorkflowRunHandler) GetOutputs(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	outputs, err := h.records.ListOutputsByRunID(r.Context(), runID)
	if err != nil {
		workflowRunLog.Error("get workflow run outputs failed", zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 workflow 执行输出失败")
		return
	}
	for i := range outputs {
		if outputs[i].ID == "" {
			continue
		}
		outputs[i].ContentURL = stringPtr("/api/workflow-runs/" + runID + "/outputs/" + outputs[i].ID + "/content")
	}
	writeData(w, outputs)
}

func (h *WorkflowRunHandler) GetOutputContent(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	outputID := chi.URLParam(r, "outputId")

	output, err := h.records.GetOutputByID(r.Context(), runID, outputID)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrWorkflowRunOutputNotFound):
			writeError(w, http.StatusNotFound, "NOT_FOUND", "workflow 执行输出不存在")
		default:
			workflowRunLog.Error("get workflow run output content failed", zap.String("runId", runID), zap.String("outputId", outputID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取 workflow 执行输出内容失败")
		}
		return
	}

	if output.StoragePath != nil && strings.TrimSpace(*output.StoragePath) != "" {
		if h.outputStorage == nil {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "workflow 执行输出内容不存在")
			return
		}

		content, err := h.outputStorage.Open(r.Context(), *output.StoragePath)
		if err != nil {
			workflowRunLog.Error("open workflow run output content failed", zap.String("runId", runID), zap.String("outputId", outputID), zap.Error(err))
			writeError(w, http.StatusBadGateway, "OUTPUT_STORAGE_UNAVAILABLE", "workflow 输出存储不可用")
			return
		}
		defer content.Body.Close()

		writeWorkflowOutputContentHeaders(w.Header(), output, content.ContentType, content.SizeBytes, content.FileName)
		w.WriteHeader(http.StatusOK)
		if _, err := io.Copy(w, content.Body); err != nil {
			workflowRunLog.Warn("stream workflow run output content failed", zap.String("runId", runID), zap.String("outputId", outputID), zap.Error(err))
		}
		return
	}

	if output.MediaURL != nil && strings.TrimSpace(*output.MediaURL) != "" {
		http.Redirect(w, r, *output.MediaURL, http.StatusTemporaryRedirect)
		return
	}

	body, contentType, size, err := serializeWorkflowRunOutputValue(*output)
	if err != nil {
		workflowRunLog.Error("serialize workflow run output content failed", zap.String("runId", runID), zap.String("outputId", outputID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "序列化 workflow 执行输出内容失败")
		return
	}

	writeWorkflowOutputContentHeaders(w.Header(), output, contentType, size, "")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(body); err != nil {
		workflowRunLog.Warn("write workflow run output content failed", zap.String("runId", runID), zap.String("outputId", outputID), zap.Error(err))
	}
}

func (h *WorkflowRunHandler) CreateRun(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")

	var raw map[string]json.RawMessage
	if err := decodeBody(r, &raw); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	if _, exists := raw["workflowId"]; exists {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "workflowId 由路径提供，不能出现在请求体中")
		return
	}
	if _, exists := raw["definition"]; exists {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "definition 不是合法输入")
		return
	}

	workflowIDJSON, err := json.Marshal(workflowID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "序列化 workflowId 失败")
		return
	}
	raw["workflowId"] = workflowIDJSON

	payload, err := json.Marshal(raw)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "构造运行请求失败")
		return
	}

	authorization := r.Header.Get("Authorization")
	resp, err := h.doRuntimeRequest(r.Context(), http.MethodPost, "/workflow/run", bytes.NewReader(payload), authorization, "application/json")
	if err != nil {
		if context.Cause(r.Context()) != nil || r.Context().Err() != nil {
			return
		}
		workflowRunLog.Error("create workflow run failed", zap.String("workflowId", workflowID), zap.Error(err))
		writeError(w, http.StatusBadGateway, "RUNTIME_UNAVAILABLE", "workflow runtime 不可用")
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		writeError(w, http.StatusBadGateway, "BAD_GATEWAY", "读取 workflow runtime 响应失败")
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBody)
		return
	}

	var envelope runtimeRunEnvelope
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		writeError(w, http.StatusBadGateway, "BAD_GATEWAY", "解析 workflow runtime 响应失败")
		return
	}

	if err := h.persistRunRecord(r.Context(), envelope.Data, middleware.GetUserID(r.Context())); err != nil {
		workflowRunLog.Error("persist workflow run record failed", zap.String("runId", envelope.Data.RunID), zap.Error(err))
		h.bestEffortAbort(envelope.Data.RunID, authorization)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "保存 workflow 执行记录失败")
		return
	}

	go h.trackRunRecord(envelope.Data.RunID, authorization)

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}

func (h *WorkflowRunHandler) GetRun(w http.ResponseWriter, r *http.Request) {
	h.proxy(w, r, http.MethodGet, "/workflow/run/"+chi.URLParam(r, "runId"), nil, "")
}

func (h *WorkflowRunHandler) GetRunState(w http.ResponseWriter, r *http.Request) {
	h.proxy(w, r, http.MethodGet, "/workflow/run/"+chi.URLParam(r, "runId")+"/state", nil, "")
}

func (h *WorkflowRunHandler) ResumeRun(w http.ResponseWriter, r *http.Request) {
	h.proxy(w, r, http.MethodPost, "/workflow/run/"+chi.URLParam(r, "runId")+"/resume", nil, "")
}

func (h *WorkflowRunHandler) StepRun(w http.ResponseWriter, r *http.Request) {
	h.proxy(w, r, http.MethodPost, "/workflow/run/"+chi.URLParam(r, "runId")+"/step", nil, "")
}

func (h *WorkflowRunHandler) AbortRun(w http.ResponseWriter, r *http.Request) {
	h.proxy(w, r, http.MethodPost, "/workflow/run/"+chi.URLParam(r, "runId")+"/abort", nil, "")
}

func (h *WorkflowRunHandler) RunEvents(w http.ResponseWriter, r *http.Request) {
	h.proxy(w, r, http.MethodGet, "/workflow/run/"+chi.URLParam(r, "runId")+"/events", nil, "")
}

func (h *WorkflowRunHandler) proxy(
	w http.ResponseWriter,
	r *http.Request,
	method string,
	path string,
	body io.Reader,
	contentType string,
) {
	resp, err := h.doRuntimeRequest(r.Context(), method, path, body, r.Header.Get("Authorization"), contentType)
	if err != nil {
		if context.Cause(r.Context()) != nil || r.Context().Err() != nil {
			return
		}
		workflowRunLog.Error("runtime request failed", zap.String("method", method), zap.String("path", path), zap.Error(err))
		writeError(w, http.StatusBadGateway, "RUNTIME_UNAVAILABLE", "workflow runtime 不可用")
		return
	}
	defer resp.Body.Close()

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		workflowRunLog.Warn("proxy runtime response failed", zap.String("path", path), zap.Error(err))
	}
}

func (h *WorkflowRunHandler) doRuntimeRequest(
	ctx context.Context,
	method string,
	path string,
	body io.Reader,
	authorization string,
	contentType string,
) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, h.runtimeBaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return h.client.Do(req)
}

func (h *WorkflowRunHandler) persistRunRecord(ctx context.Context, info runtimeRunState, userID string) error {
	var triggeredBy *string
	if userID != "" {
		triggeredBy = &userID
	}
	_, err := h.records.Create(ctx, store.CreateWorkflowRunRecordInput{
		RunID:                info.RunID,
		WorkflowID:           info.WorkflowID,
		WorkflowRevision:     info.WorkflowRevision,
		Status:               info.Status,
		StartedAt:            unixMilliToTime(info.StartedAt),
		CompletedAt:          unixMilliToTimePtr(info.CompletedAt),
		CurrentNodeID:        info.CurrentNodeID,
		PausedAtNodeID:       info.PausedAtNodeID,
		PausedBreakpointType: info.PausedBreakpointType,
		ErrorMessage:         info.ErrorMessage,
		TriggeredBy:          triggeredBy,
	})
	return err
}

func (h *WorkflowRunHandler) trackRunRecord(runID string, authorization string) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		state, err := h.fetchRuntimeRunState(ctx, runID, authorization)
		if err != nil {
			if errors.Is(err, store.ErrWorkflowRunRecordNotFound) || context.Cause(ctx) != nil || ctx.Err() != nil {
				return
			}
			workflowRunLog.Warn("sync workflow run record failed", zap.String("runId", runID), zap.Error(err))
		} else {
			if err := h.records.UpdateState(ctx, runID, runtimeStateToRecordUpdate(state)); err != nil {
				if !errors.Is(err, store.ErrWorkflowRunRecordNotFound) {
					workflowRunLog.Warn("update workflow run record failed", zap.String("runId", runID), zap.Error(err))
				}
				return
			}
			outputs := runtimeStateToRunOutputs(runID, state)
			if h.outputStorage != nil {
				outputs = h.materializeRunOutputs(ctx, outputs)
			}
			if err := h.records.ReplaceOutputs(ctx, runID, outputs); err != nil {
				if !errors.Is(err, store.ErrWorkflowRunRecordNotFound) {
					workflowRunLog.Warn("replace workflow run outputs failed", zap.String("runId", runID), zap.Error(err))
				}
				return
			}
			if isTerminalRunStatus(state.Status) {
				return
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (h *WorkflowRunHandler) fetchRuntimeRunState(ctx context.Context, runID string, authorization string) (runtimeRunState, error) {
	resp, err := h.doRuntimeRequest(ctx, http.MethodGet, "/workflow/run/"+runID+"/state", nil, authorization, "")
	if err != nil {
		return runtimeRunState{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return runtimeRunState{}, store.ErrWorkflowRunRecordNotFound
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return runtimeRunState{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return runtimeRunState{}, errors.New("runtime returned non-success status while syncing run record")
	}

	var envelope runtimeRunEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return runtimeRunState{}, err
	}
	return envelope.Data, nil
}

func (h *WorkflowRunHandler) bestEffortAbort(runID string, authorization string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := h.doRuntimeRequest(ctx, http.MethodPost, "/workflow/run/"+runID+"/abort", nil, authorization, "")
	if err != nil {
		workflowRunLog.Warn("best effort abort failed", zap.String("runId", runID), zap.Error(err))
		return
	}
	resp.Body.Close()
}

func runtimeStateToRecordUpdate(state runtimeRunState) store.UpdateWorkflowRunRecordInput {
	update := store.UpdateWorkflowRunRecordInput{
		Status:               &state.Status,
		CurrentNodeID:        firstNonNilString(state.FailedNodeID, state.CurrentNodeID),
		CurrentNodeIDSet:     true,
		PausedAtNodeID:       state.PausedAtNodeID,
		PausedAtNodeIDSet:    true,
		PausedBreakpointType: state.PausedBreakpointType,
		PausedBreakpointSet:  true,
		ErrorMessage:         state.ErrorMessage,
		ErrorMessageSet:      true,
	}
	if state.CompletedAt != nil {
		completedAt := unixMilliToTime(*state.CompletedAt)
		update.CompletedAt = &completedAt
	}
	return update
}

func unixMilliToTime(ms int64) time.Time {
	return time.UnixMilli(ms).UTC()
}

func unixMilliToTimePtr(ms *int64) *time.Time {
	if ms == nil {
		return nil
	}
	value := unixMilliToTime(*ms)
	return &value
}

func isTerminalRunStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "aborted"
}

func firstNonNilString(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func runtimeStateToRunOutputs(runID string, state runtimeRunState) []store.WorkflowRunOutputInput {
	var outputs []store.WorkflowRunOutputInput
	for nodeID, nodeState := range state.NodeStates {
		for _, output := range nodeState.Outputs {
			outputs = append(outputs, store.NormalizeWorkflowRunOutput(runID, nodeID, output.PinID, output.Value))
		}
	}
	return outputs
}

func (h *WorkflowRunHandler) materializeRunOutputs(ctx context.Context, outputs []store.WorkflowRunOutputInput) []store.WorkflowRunOutputInput {
	resolved := make([]store.WorkflowRunOutputInput, 0, len(outputs))
	for _, output := range outputs {
		materialized, err := h.outputStorage.Materialize(ctx, output)
		if err != nil {
			workflowRunLog.Warn("materialize workflow run output failed", zap.String("runId", output.RunID), zap.String("nodeId", output.NodeID), zap.String("pinId", output.PinID), zap.Error(err))
			resolved = append(resolved, output)
			continue
		}
		resolved = append(resolved, materialized)
	}
	return resolved
}

func serializeWorkflowRunOutputValue(output model.WorkflowRunOutput) ([]byte, string, int64, error) {
	if output.Kind == "text" {
		if text, ok := output.Value.(string); ok {
			return []byte(text), firstNonEmptyString(derefString(output.MimeType), "text/plain; charset=utf-8"), int64(len(text)), nil
		}
	}

	body, err := json.Marshal(output.Value)
	if err != nil {
		return nil, "", 0, err
	}

	contentType := derefString(output.MimeType)
	if contentType == "" {
		contentType = "application/json"
	}
	return body, contentType, int64(len(body)), nil
}

func writeWorkflowOutputContentHeaders(header http.Header, output *model.WorkflowRunOutput, contentType string, size int64, fallbackFileName string) {
	if strings.TrimSpace(contentType) != "" {
		header.Set("Content-Type", contentType)
	}
	if size >= 0 {
		header.Set("Content-Length", strconv.FormatInt(size, 10))
	}

	fileName := derefString(output.FileName)
	if fileName == "" {
		fileName = strings.TrimSpace(fallbackFileName)
	}
	if fileName != "" {
		header.Set("Content-Disposition", "inline; filename="+strconv.Quote(fileName))
	}
}

func stringPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	copyValue := value
	return &copyValue
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		switch strings.ToLower(key) {
		case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade":
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
