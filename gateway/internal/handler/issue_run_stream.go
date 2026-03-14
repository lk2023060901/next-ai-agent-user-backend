package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"
)

func (h *IssueHandler) StreamRunEvents(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "runId is required")
		return
	}
	run, err := h.issues.GetRunByID(r.Context(), runID)
	if err != nil {
		issueLog.Error("load issue run for stream failed", zap.String("runId", runID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取 issue run 失败")
		return
	}
	if run == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "issue run 不存在")
		return
	}
	if err := h.runs.ReconcileStaleRuns(r.Context(), run.WorkspaceID); err != nil {
		issueLog.Warn("reconcile stale issue runs before stream failed", zap.String("workspaceId", run.WorkspaceID), zap.Error(err))
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	events, err := h.issues.ListRunEvents(r.Context(), runID)
	if err != nil {
		issueLog.Error("load issue run events for stream failed", zap.String("runId", runID), zap.Error(err))
		return
	}
	events = hydrateIssueRunEvents(events, run)
	writeIssueSSE(w, "snapshot", map[string]interface{}{"run": run})
	lastSeq := 0
	for _, event := range events {
		writeIssueSSE(w, event.EventType, event)
		lastSeq = event.Seq
	}
	if flusher != nil {
		flusher.Flush()
	}
	if isTerminalIssueRunStatus(run.Status) {
		writeIssueSSE(w, "done", map[string]interface{}{})
		if flusher != nil {
			flusher.Flush()
		}
		return
	}

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := h.streamIssueRunTick(r.Context(), w, flusher, runID, &lastSeq); err != nil {
				issueLog.Warn("stream issue run tick failed", zap.String("runId", runID), zap.Error(err))
				return
			}
			run, err = h.issues.GetRunByID(r.Context(), runID)
			if err == nil && run != nil && isTerminalIssueRunStatus(run.Status) {
				writeIssueSSE(w, "done", map[string]interface{}{})
				if flusher != nil {
					flusher.Flush()
				}
				return
			}
		}
	}
}

func (h *IssueHandler) streamIssueRunTick(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, runID string, lastSeq *int) error {
	run, err := h.issues.GetRunByID(ctx, runID)
	if err != nil {
		return err
	}
	events, err := h.issues.ListRunEventsAfterSeq(ctx, runID, *lastSeq)
	if err != nil {
		return err
	}
	events = hydrateIssueRunEvents(events, run)
	for _, event := range events {
		writeIssueSSE(w, event.EventType, event)
		*lastSeq = event.Seq
	}
	if flusher != nil {
		flusher.Flush()
	}
	return nil
}

func writeIssueSSE(w http.ResponseWriter, name string, data interface{}) {
	body, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, body)
}
