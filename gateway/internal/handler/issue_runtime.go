package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var errIssueRuntimeRunNotFound = errors.New("issue runtime run not found")

const (
	issueRunHeartbeatTTL   = 2 * time.Minute
	issueRunDefaultTimeout = 35 * time.Minute
)

type IssueRunStartRequest struct {
	AgentID           string
	ExecutionMode     string
	ExecutionModeSet  bool
	ExecutorName      *string
	ExecutorHostname  *string
	ExecutorPlatform  *string
	RunID             string
	ExpectedStatuses  []string
	TriggerSource     string
	TriggerDetail     *string
	Goal              *string
	Title             *string
	UserMessage       *string
	RequestedByUserID *string
	Authorization     string
}

type IssueRuntimeBridge struct {
	runtimeBaseURL string
	client         *http.Client
	issues         *store.IssueStore
	agents         *store.AgentStore
}

type runtimeIssueRunEnvelope struct {
	Data runtimeIssueRunState `json:"data"`
}

type runtimeIssueRunState struct {
	RunID            string  `json:"runId"`
	IssueID          string  `json:"issueId"`
	WorkspaceID      string  `json:"workspaceId"`
	AgentID          string  `json:"agentId"`
	ExecutionMode    string  `json:"executionMode"`
	ExecutorName     *string `json:"executorName,omitempty"`
	ExecutorHostname *string `json:"executorHostname,omitempty"`
	ExecutorPlatform *string `json:"executorPlatform,omitempty"`
	Status           string  `json:"status"`
	TriggerSource    string  `json:"triggerSource"`
	TriggerDetail    *string `json:"triggerDetail,omitempty"`
	CurrentStep      *string `json:"currentStep,omitempty"`
	ErrorMessage     *string `json:"errorMessage,omitempty"`
	ResultText       *string `json:"resultText,omitempty"`
	StartedAt        int64   `json:"startedAt"`
	CompletedAt      *int64  `json:"completedAt,omitempty"`
}

func NewIssueRuntimeBridge(runtimeBaseURL string, issues *store.IssueStore, agents *store.AgentStore) *IssueRuntimeBridge {
	return &IssueRuntimeBridge{
		runtimeBaseURL: strings.TrimRight(runtimeBaseURL, "/"),
		client:         &http.Client{},
		issues:         issues,
		agents:         agents,
	}
}

func (b *IssueRuntimeBridge) EnsureRun(ctx context.Context, issue *model.Issue, agentID, executionMode string, executionModeSet bool, executorName, executorHostname, executorPlatform *string, runID, triggerSource string, triggerDetail, requestedByUserID *string) (*model.IssueRun, error) {
	if issue == nil {
		return nil, fmt.Errorf("issue is required")
	}
	if strings.TrimSpace(executionMode) == "" {
		executionMode = "cloud"
	}
	if strings.TrimSpace(runID) == "" {
		runID = uuid.NewString()
	}
	existing, err := b.issues.GetRunByID(ctx, runID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.IssueID != issue.ID || existing.AgentID != agentID {
			return nil, fmt.Errorf("runId already belongs to another issue execution")
		}
		update := store.UpdateIssueRunInput{}
		needsUpdate := false
		if executionModeSet && strings.TrimSpace(existing.ExecutionMode) != executionMode {
			update.ExecutionMode = &executionMode
			update.ExecutionModeSet = true
			needsUpdate = true
		}
		if existing.ExecutionMode == "" {
			update.ExecutionMode = &executionMode
			update.ExecutionModeSet = true
			needsUpdate = true
		}
		if executorName != nil && derefIssueString(existing.ExecutorName) != derefIssueString(executorName) {
			update.ExecutorName = executorName
			update.ExecutorNameSet = true
			needsUpdate = true
		}
		if executorHostname != nil && derefIssueString(existing.ExecutorHostname) != derefIssueString(executorHostname) {
			update.ExecutorHostname = executorHostname
			update.ExecutorHostnameSet = true
			needsUpdate = true
		}
		if executorPlatform != nil && derefIssueString(existing.ExecutorPlatform) != derefIssueString(executorPlatform) {
			update.ExecutorPlatform = executorPlatform
			update.ExecutorPlatformSet = true
			needsUpdate = true
		}
		if needsUpdate {
			return b.issues.UpdateRun(ctx, existing.ID, update)
		}
		return existing, nil
	}
	now := time.Now().UTC()
	timeoutAt := now.Add(issueRunDefaultTimeout)
	run, err := b.issues.CreateRun(ctx, store.CreateIssueRunInput{
		ID:                runID,
		IssueID:           issue.ID,
		WorkspaceID:       issue.WorkspaceID,
		AgentID:           agentID,
		ExecutionMode:     executionMode,
		ExecutorName:      executorName,
		ExecutorHostname:  executorHostname,
		ExecutorPlatform:  executorPlatform,
		Status:            "pending",
		TriggerSource:     firstNonEmpty(triggerSource, "manual"),
		TriggerDetail:     triggerDetail,
		RequestedByUserID: requestedByUserID,
		HeartbeatAt:       &now,
		TimeoutAt:         &timeoutAt,
	})
	if err != nil {
		return nil, err
	}
	actorType := "agent"
	actorID := inputRequestedActorID(requestedByUserID, nil)
	if requestedByUserID != nil {
		actorType = "user"
	}
	_ = b.recordRunActivity(ctx, run, "issue.run_queued", actorType, actorID, issueRunTimelineTitle(*run), issueRunTimelineDescription(*run, b.agentDisplayName(ctx, agentID)))
	return run, nil
}

func (b *IssueRuntimeBridge) SyncExecutionLock(ctx context.Context, issueID, agentID string) error {
	agentKey := strings.TrimSpace(agentID)
	if agent, err := b.agents.GetByID(ctx, agentID); err == nil && agent != nil {
		if agent.Identifier != nil && strings.TrimSpace(*agent.Identifier) != "" {
			agentKey = strings.TrimSpace(*agent.Identifier)
		} else if strings.TrimSpace(agent.Name) != "" {
			agentKey = strings.TrimSpace(agent.Name)
		}
	}
	run, err := b.issues.GetActiveRunByIssue(ctx, issueID)
	if err != nil {
		return err
	}
	if run == nil {
		return nil
	}
	return b.issues.SetExecutionLock(ctx, issueID, run.ID, agentKey)
}

func (b *IssueRuntimeBridge) Start(ctx context.Context, issue *model.Issue, request IssueRunStartRequest) (*model.IssueRun, *model.Issue, error) {
	if err := b.ReconcileStaleRuns(ctx, issue.WorkspaceID); err != nil {
		return nil, nil, err
	}
	run, err := b.EnsureRun(ctx, issue, request.AgentID, request.ExecutionMode, request.ExecutionModeSet, request.ExecutorName, request.ExecutorHostname, request.ExecutorPlatform, request.RunID, request.TriggerSource, request.TriggerDetail, request.RequestedByUserID)
	if err != nil {
		return nil, nil, err
	}
	checkedOut, err := b.issues.Checkout(ctx, issue.ID, request.AgentID, request.ExpectedStatuses, run.ID)
	if err != nil {
		b.failStart(ctx, issue.ID, run.ID, err)
		return nil, nil, err
	}
	if err := b.SyncExecutionLock(ctx, checkedOut.ID, request.AgentID); err != nil {
		return nil, nil, err
	}

	payload := map[string]interface{}{
		"runId":         run.ID,
		"issueId":       issue.ID,
		"workspaceId":   issue.WorkspaceID,
		"agentId":       request.AgentID,
		"executionMode": run.ExecutionMode,
		"triggerSource": firstNonEmpty(request.TriggerSource, "manual"),
	}
	if run.ExecutorName != nil {
		payload["executorName"] = *run.ExecutorName
	}
	if run.ExecutorHostname != nil {
		payload["executorHostname"] = *run.ExecutorHostname
	}
	if run.ExecutorPlatform != nil {
		payload["executorPlatform"] = *run.ExecutorPlatform
	}
	if request.TriggerDetail != nil {
		payload["triggerDetail"] = *request.TriggerDetail
	}
	if request.Goal != nil {
		payload["goal"] = *request.Goal
	}
	if request.Title != nil {
		payload["title"] = *request.Title
	}
	if request.UserMessage != nil {
		payload["userMessage"] = *request.UserMessage
	}

	resp, err := b.doRuntimeRequest(ctx, http.MethodPost, "/issue-runs", marshalJSONBody(payload), request.Authorization, "application/json")
	if err != nil {
		b.failStart(ctx, issue.ID, run.ID, err)
		return nil, nil, issueErrorf("start issue run", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		b.failStart(ctx, issue.ID, run.ID, err)
		return nil, nil, issueErrorf("read issue runtime response", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b.failStart(ctx, issue.ID, run.ID, fmt.Errorf("runtime returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body))))
		return nil, nil, fmt.Errorf("bad request: runtime returned status %d", resp.StatusCode)
	}

	var envelope runtimeIssueRunEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		b.failStart(ctx, issue.ID, run.ID, err)
		return nil, nil, issueErrorf("decode issue runtime response", err)
	}
	if envelope.Data.RunID == "" {
		envelope.Data.RunID = run.ID
		envelope.Data.IssueID = issue.ID
		envelope.Data.WorkspaceID = issue.WorkspaceID
		envelope.Data.AgentID = request.AgentID
		envelope.Data.Status = "running"
	}
	syncedRun, err := b.syncState(ctx, envelope.Data)
	if err != nil {
		return nil, nil, err
	}
	go b.streamEvents(run.ID, issue.ID, issue.WorkspaceID, request.Authorization)
	go b.trackState(run.ID, request.Authorization)
	updatedIssue, err := b.issues.GetByID(ctx, issue.ID)
	if err != nil {
		return nil, nil, err
	}
	return syncedRun, updatedIssue, nil
}

func (b *IssueRuntimeBridge) GetState(ctx context.Context, runID, authorization string) (interface{}, error) {
	state, err := b.fetchState(ctx, runID, authorization)
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, errIssueRuntimeRunNotFound) {
		return nil, err
	}
	run, runErr := b.issues.GetRunByID(ctx, runID)
	if runErr != nil {
		return nil, runErr
	}
	if run == nil {
		return nil, errIssueRuntimeRunNotFound
	}
	return runtimeIssueRunState{
		RunID:            run.ID,
		IssueID:          run.IssueID,
		WorkspaceID:      run.WorkspaceID,
		AgentID:          run.AgentID,
		ExecutionMode:    run.ExecutionMode,
		ExecutorName:     run.ExecutorName,
		ExecutorHostname: run.ExecutorHostname,
		ExecutorPlatform: run.ExecutorPlatform,
		Status:           run.Status,
		TriggerSource:    run.TriggerSource,
		TriggerDetail:    run.TriggerDetail,
		ErrorMessage:     run.ErrorMessage,
		ResultText:       run.ResultText,
		StartedAt:        timeToUnixMillis(run.StartedAt),
		CompletedAt:      timePtrToUnixMillis(run.FinishedAt),
	}, nil
}

func (b *IssueRuntimeBridge) Abort(ctx context.Context, runID, authorization string) error {
	run, runErr := b.issues.GetRunByID(ctx, runID)
	if runErr != nil {
		return runErr
	}
	if run == nil {
		return errIssueRuntimeRunNotFound
	}
	if isTerminalIssueRunStatus(run.Status) {
		return nil
	}
	resp, err := b.doRuntimeRequest(ctx, http.MethodPost, "/issue-runs/"+runID+"/abort", nil, authorization, "")
	runtimeErr := err
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
			return fmt.Errorf("runtime returned status %d", resp.StatusCode)
		}
		if resp.StatusCode == http.StatusNotFound {
			runtimeErr = errIssueRuntimeRunNotFound
		}
	}
	if run == nil {
		return runtimeErr
	}
	now := time.Now().UTC()
	aborted := "aborted"
	_, updateErr := b.issues.UpdateRun(ctx, run.ID, store.UpdateIssueRunInput{
		Status:         &aborted,
		FinishedAt:     &now,
		FinishedAtSet:  true,
		HeartbeatAt:    &now,
		HeartbeatAtSet: true,
	})
	if updateErr != nil {
		return updateErr
	}
	_ = b.issues.ClearRunLocks(ctx, run.IssueID, run.ID)
	run.Status = aborted
	run.FinishedAt = &now
	_ = b.recordRunActivity(ctx, run, "issue.run_aborted", "agent", optionalString(run.AgentID), issueRunTimelineTitle(*run), issueRunTimelineDescription(*run, b.agentDisplayName(ctx, run.AgentID)))
	return nil
}

func (b *IssueRuntimeBridge) AbortBestEffort(runID, authorization string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.Abort(ctx, runID, authorization); err != nil && !errors.Is(err, errIssueRuntimeRunNotFound) {
		issueLog.Warn("best effort abort issue run failed", zap.String("runId", runID), zap.Error(err))
	}
}

func (b *IssueRuntimeBridge) trackState(runID, authorization string) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		state, err := b.fetchState(ctx, runID, authorization)
		if err == nil {
			_, syncErr := b.syncState(ctx, state)
			if syncErr != nil {
				issueLog.Warn("sync issue run state failed", zap.String("runId", runID), zap.Error(syncErr))
			}
			if isTerminalIssueRunStatus(state.Status) {
				return
			}
		} else if !errors.Is(err, errIssueRuntimeRunNotFound) && ctx.Err() == nil {
			issueLog.Warn("fetch issue run state failed", zap.String("runId", runID), zap.Error(err))
		} else if errors.Is(err, errIssueRuntimeRunNotFound) && ctx.Err() == nil {
			if run, loadErr := b.issues.GetRunByID(ctx, runID); loadErr == nil && run != nil && !isTerminalIssueRunStatus(run.Status) {
				_ = b.failRun(ctx, run, "Issue runtime lost the run state")
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (b *IssueRuntimeBridge) streamEvents(runID, issueID, workspaceID, authorization string) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()
	existing, err := b.issues.ListRunEvents(ctx, runID)
	if err != nil {
		issueLog.Warn("load existing issue run events failed", zap.String("runId", runID), zap.Error(err))
	}
	seq := len(existing)
	resp, err := b.doRuntimeRequest(ctx, http.MethodGet, "/issue-runs/"+runID+"/events", nil, authorization, "")
	if err != nil {
		issueLog.Warn("open issue run event stream failed", zap.String("runId", runID), zap.Error(err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		issueLog.Warn("issue run event stream returned non-success status", zap.String("runId", runID), zap.Int("status", resp.StatusCode))
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	currentEvent := ""
	dataLines := []string{}
	shouldStop := false
	flush := func() {
		if currentEvent == "" && len(dataLines) == 0 {
			return
		}
		payload := map[string]interface{}{}
		joined := strings.TrimSpace(strings.Join(dataLines, "\n"))
		if joined != "" {
			var decoded interface{}
			if err := json.Unmarshal([]byte(joined), &decoded); err == nil {
				switch value := decoded.(type) {
				case map[string]interface{}:
					payload = value
				default:
					payload["data"] = value
				}
			} else {
				payload["data"] = joined
			}
		}
		seq++
		if _, err := b.issues.AddRunEvent(ctx, store.CreateIssueRunEventInput{
			RunID:       runID,
			IssueID:     issueID,
			WorkspaceID: workspaceID,
			Seq:         seq,
			EventType:   firstNonEmpty(currentEvent, "message"),
			Payload:     payload,
		}); err != nil {
			issueLog.Warn("persist issue run event failed", zap.String("runId", runID), zap.Int("seq", seq), zap.Error(err))
		}
		if currentEvent == "comment.created" {
			if body, ok := payload["body"].(string); ok {
				if err := b.ensureCommentFromEvent(ctx, runID, body); err != nil {
					issueLog.Warn("persist issue run comment event failed", zap.String("runId", runID), zap.Error(err))
				}
			}
		}
		if currentEvent == "done" {
			shouldStop = true
		}
		currentEvent = ""
		dataLines = nil
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
			if shouldStop {
				return
			}
			continue
		}
		if strings.HasPrefix(line, "event:") {
			currentEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	flush()
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		issueLog.Warn("read issue run event stream failed", zap.String("runId", runID), zap.Error(err))
	}
}

func (b *IssueRuntimeBridge) fetchState(ctx context.Context, runID, authorization string) (runtimeIssueRunState, error) {
	resp, err := b.doRuntimeRequest(ctx, http.MethodGet, "/issue-runs/"+runID+"/state", nil, authorization, "")
	if err != nil {
		return runtimeIssueRunState{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return runtimeIssueRunState{}, errIssueRuntimeRunNotFound
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return runtimeIssueRunState{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return runtimeIssueRunState{}, fmt.Errorf("runtime returned status %d", resp.StatusCode)
	}
	var envelope runtimeIssueRunEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return runtimeIssueRunState{}, err
	}
	return envelope.Data, nil
}

func (b *IssueRuntimeBridge) syncState(ctx context.Context, state runtimeIssueRunState) (*model.IssueRun, error) {
	existing, err := b.issues.GetRunByID(ctx, state.RunID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	input := store.UpdateIssueRunInput{
		Status:         stateStatusPtr(state.Status),
		HeartbeatAt:    &now,
		HeartbeatAtSet: true,
	}
	timeoutAt := now.Add(issueRunDefaultTimeout)
	input.TimeoutAt = &timeoutAt
	input.TimeoutAtSet = true
	if state.StartedAt > 0 {
		startedAt := time.UnixMilli(state.StartedAt).UTC()
		input.StartedAt = &startedAt
		input.StartedAtSet = true
	}
	if state.CompletedAt != nil && *state.CompletedAt > 0 {
		finishedAt := time.UnixMilli(*state.CompletedAt).UTC()
		input.FinishedAt = &finishedAt
		input.FinishedAtSet = true
	}
	if state.ErrorMessage != nil {
		input.ErrorMessage = trimOptionalString(state.ErrorMessage)
		input.ErrorMessageSet = true
	}
	if state.ResultText != nil {
		input.ResultText = trimOptionalString(state.ResultText)
		input.ResultTextSet = true
	}
	if state.TriggerDetail != nil {
		input.TriggerDetail = trimOptionalString(state.TriggerDetail)
		input.TriggerDetailSet = true
	}
	run, err := b.issues.UpdateRun(ctx, state.RunID, input)
	if err != nil {
		return nil, err
	}
	if run == nil {
		run, err = b.issues.GetRunByID(ctx, state.RunID)
		if err != nil {
			return nil, err
		}
	}
	if existing == nil || existing.Status != run.Status {
		_ = b.recordRunActivity(ctx, run, issueRunActivityAction(run.Status), "agent", optionalString(run.AgentID), issueRunTimelineTitle(*run), issueRunTimelineDescription(*run, b.agentDisplayName(ctx, run.AgentID)))
	}
	if isTerminalIssueRunStatus(state.Status) {
		_ = b.issues.ClearRunLocks(ctx, state.IssueID, state.RunID)
		if err := b.ensureResultComment(ctx, run, state); err != nil {
			issueLog.Warn("persist issue run result comment failed", zap.String("runId", state.RunID), zap.Error(err))
		}
	}
	return run, nil
}

func (b *IssueRuntimeBridge) ensureResultComment(ctx context.Context, run *model.IssueRun, state runtimeIssueRunState) error {
	if run == nil || run.ResultCommentID != nil || state.ResultText == nil || strings.TrimSpace(*state.ResultText) == "" {
		return nil
	}
	comment, err := b.issues.AddComment(ctx, store.CreateIssueCommentInput{
		WorkspaceID:   run.WorkspaceID,
		IssueID:       run.IssueID,
		AuthorAgentID: optionalString(run.AgentID),
		Body:          strings.TrimSpace(*state.ResultText),
	})
	if err != nil {
		return err
	}
	trimmedResult := strings.TrimSpace(*state.ResultText)
	_, err = b.issues.UpdateRun(ctx, run.ID, store.UpdateIssueRunInput{
		ResultText:         &trimmedResult,
		ResultTextSet:      true,
		ResultCommentID:    &comment.ID,
		ResultCommentIDSet: true,
	})
	return err
}

func (b *IssueRuntimeBridge) ensureCommentFromEvent(ctx context.Context, runID string, body string) error {
	run, err := b.issues.GetRunByID(ctx, runID)
	if err != nil || run == nil || run.ResultCommentID != nil || strings.TrimSpace(body) == "" {
		return err
	}
	comment, err := b.issues.AddComment(ctx, store.CreateIssueCommentInput{
		WorkspaceID:   run.WorkspaceID,
		IssueID:       run.IssueID,
		AuthorAgentID: optionalString(run.AgentID),
		Body:          strings.TrimSpace(body),
	})
	if err != nil {
		return err
	}
	trimmedBody := strings.TrimSpace(body)
	_, err = b.issues.UpdateRun(ctx, run.ID, store.UpdateIssueRunInput{
		ResultText:         &trimmedBody,
		ResultTextSet:      true,
		ResultCommentID:    &comment.ID,
		ResultCommentIDSet: true,
	})
	return err
}

func (b *IssueRuntimeBridge) failStart(ctx context.Context, issueID, runID string, err error) {
	now := time.Now().UTC()
	failed := "failed"
	message := err.Error()
	run, _ := b.issues.UpdateRun(ctx, runID, store.UpdateIssueRunInput{
		Status:          &failed,
		FinishedAt:      &now,
		FinishedAtSet:   true,
		ErrorMessage:    &message,
		ErrorMessageSet: true,
		HeartbeatAt:     &now,
		HeartbeatAtSet:  true,
	})
	_ = b.issues.ClearRunLocks(ctx, issueID, runID)
	if run != nil {
		_ = b.recordRunActivity(ctx, run, "issue.run_failed", "agent", optionalString(run.AgentID), issueRunTimelineTitle(*run), message)
	}
}

func (b *IssueRuntimeBridge) ReconcileStaleRuns(ctx context.Context, workspaceID string) error {
	now := time.Now().UTC()
	runs, err := b.issues.ExpireStaleRuns(ctx, now.Add(-issueRunHeartbeatTTL), now)
	if err != nil {
		return err
	}
	for i := range runs {
		run := runs[i]
		if workspaceID != "" && run.WorkspaceID != workspaceID {
			continue
		}
		_ = b.issues.ClearRunLocks(ctx, run.IssueID, run.ID)
		_ = b.recordRunActivity(ctx, &run, "issue.run_failed", "system", nil, issueRunTimelineTitle(run), firstNonEmpty(derefIssueString(run.ErrorMessage), "Issue run heartbeat expired"))
	}
	return nil
}

func (b *IssueRuntimeBridge) failRun(ctx context.Context, run *model.IssueRun, message string) error {
	if run == nil {
		return nil
	}
	now := time.Now().UTC()
	failed := "failed"
	updated, err := b.issues.UpdateRun(ctx, run.ID, store.UpdateIssueRunInput{
		Status:          &failed,
		FinishedAt:      &now,
		FinishedAtSet:   true,
		ErrorMessage:    optionalString(message),
		ErrorMessageSet: true,
		HeartbeatAt:     &now,
		HeartbeatAtSet:  true,
	})
	if err != nil {
		return err
	}
	if updated == nil {
		return nil
	}
	_ = b.issues.ClearRunLocks(ctx, run.IssueID, run.ID)
	return b.recordRunActivity(ctx, updated, "issue.run_failed", "agent", optionalString(run.AgentID), issueRunTimelineTitle(*updated), firstNonEmpty(derefIssueString(updated.ErrorMessage), message))
}

func (b *IssueRuntimeBridge) agentDisplayName(ctx context.Context, agentID string) string {
	if agent, err := b.agents.GetByID(ctx, agentID); err == nil && agent != nil {
		if strings.TrimSpace(agent.Name) != "" {
			return strings.TrimSpace(agent.Name)
		}
	}
	return strings.TrimSpace(agentID)
}

func (b *IssueRuntimeBridge) recordRunActivity(ctx context.Context, run *model.IssueRun, action, actorType string, actorID *string, title, description string) error {
	if run == nil {
		return nil
	}
	metadata := map[string]interface{}{
		"runId":            run.ID,
		"agentId":          run.AgentID,
		"status":           run.Status,
		"executionMode":    run.ExecutionMode,
		"executorName":     run.ExecutorName,
		"executorHostname": run.ExecutorHostname,
		"executorPlatform": run.ExecutorPlatform,
	}
	return b.issues.AddActivityEvent(ctx, run.WorkspaceID, "issue", run.IssueID, action, actorType, actorID, title, description, metadata)
}

func inputRequestedActorID(userID, agentID *string) *string {
	if userID != nil {
		return userID
	}
	return agentID
}

func issueRunActivityAction(status string) string {
	switch strings.TrimSpace(status) {
	case "pending":
		return "issue.run_queued"
	case "running":
		return "issue.run_started"
	case "completed":
		return "issue.run_completed"
	case "failed":
		return "issue.run_failed"
	case "aborted":
		return "issue.run_aborted"
	default:
		return "issue.run_updated"
	}
}

func (b *IssueRuntimeBridge) doRuntimeRequest(ctx context.Context, method, path string, body io.Reader, authorization, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, b.runtimeBaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return b.client.Do(req)
}

func stateStatusPtr(status string) *string {
	trimmed := strings.TrimSpace(status)
	if trimmed == "" {
		return nil
	}
	copyValue := trimmed
	return &copyValue
}

func timeToUnixMillis(value *time.Time) int64 {
	if value == nil {
		return 0
	}
	return value.UTC().UnixMilli()
}

func timePtrToUnixMillis(value *time.Time) *int64 {
	if value == nil {
		return nil
	}
	ms := value.UTC().UnixMilli()
	return &ms
}
