package handler

import (
	"context"
	"fmt"
	"strings"

	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

type issueCommentAction struct {
	Type             string  `json:"type"`
	AgentID          *string `json:"agentId"`
	ExecutionMode    *string `json:"executionMode"`
	ExecutorName     *string `json:"executorName"`
	ExecutorHostname *string `json:"executorHostname"`
	ExecutorPlatform *string `json:"executorPlatform"`
	ApprovalID       *string `json:"approvalId"`
	Title            *string `json:"title"`
	Description      *string `json:"description"`
	DecisionNote     *string `json:"decisionNote"`
}

type issueCommentActionResult struct {
	Type       string          `json:"type"`
	Status     string          `json:"status"`
	Message    string          `json:"message,omitempty"`
	Run        *model.IssueRun `json:"run,omitempty"`
	ApprovalID *string         `json:"approvalId,omitempty"`
}

func (h *IssueHandler) validateCommentActions(ctx context.Context, issue *model.Issue, actions []issueCommentAction) error {
	for _, action := range actions {
		actionType := strings.TrimSpace(action.Type)
		switch actionType {
		case "reopen", "request_approval":
			continue
		case "wake_agent", "mention":
			agentID := firstNonEmpty(derefIssueString(action.AgentID), derefIssueString(issue.AssigneeAgentID))
			if agentID == "" {
				return fmt.Errorf("%s requires agentId or issue assigneeAgentId", actionType)
			}
			if err := h.validateAgentBelongsToIssueWorkspace(ctx, issue, agentID); err != nil {
				return err
			}
			if actionType == "wake_agent" {
				if _, _, err := normalizeExecutionMode(action.ExecutionMode); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unsupported comment action: %s", actionType)
		}
	}
	return nil
}

func (h *IssueHandler) executeCommentActions(ctx context.Context, issue *model.Issue, body string, actions []issueCommentAction, userID, authorization string) ([]issueCommentActionResult, *model.Issue) {
	results := make([]issueCommentActionResult, 0, len(actions))
	current := issue
	for _, action := range actions {
		actionType := strings.TrimSpace(action.Type)
		switch actionType {
		case "reopen":
			updated, changed, err := h.reopenIssueFromComment(ctx, current, userID)
			if err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			current = updated
			message := "Issue already open"
			status := "noop"
			if changed {
				status = "ok"
				message = "Issue reopened"
				_ = h.addSystemIssueComment(ctx, current, "Issue reopened from comment action.")
			}
			results = append(results, issueCommentActionResult{Type: actionType, Status: status, Message: message})
		case "wake_agent":
			agentID := firstNonEmpty(derefIssueString(action.AgentID), derefIssueString(current.AssigneeAgentID))
			if agentID == "" {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: "wake_agent requires agentId or issue assigneeAgentId"})
				continue
			}
			if err := h.validateAgentBelongsToIssueWorkspace(ctx, current, agentID); err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			executionMode, executionModeSet, err := normalizeExecutionMode(action.ExecutionMode)
			if err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			run, updatedIssue, err := h.runs.Start(ctx, current, IssueRunStartRequest{
				AgentID:           agentID,
				ExecutionMode:     executionMode,
				ExecutionModeSet:  executionModeSet,
				ExecutorName:      trimOptionalString(action.ExecutorName),
				ExecutorHostname:  trimOptionalString(action.ExecutorHostname),
				ExecutorPlatform:  trimOptionalString(action.ExecutorPlatform),
				ExpectedStatuses:  []string{"backlog", "todo", "blocked", "in_review", "done", "cancelled"},
				TriggerSource:     "comment.wake_agent",
				TriggerDetail:     trimOptionalString(&body),
				Goal:              trimOptionalString(action.Title),
				Title:             firstOptionalNonEmpty(trimOptionalString(action.Title), &current.Title),
				UserMessage:       firstOptionalNonEmpty(trimOptionalString(action.Description), trimOptionalString(&body), current.Description),
				RequestedByUserID: optionalString(userID),
				Authorization:     authorization,
			})
			if err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			current = updatedIssue
			_ = h.addSystemIssueComment(ctx, current, "Agent wake requested and run queued.")
			results = append(results, issueCommentActionResult{Type: actionType, Status: "ok", Message: "Agent wake requested", Run: run})
		case "mention":
			agentID := firstNonEmpty(derefIssueString(action.AgentID), derefIssueString(current.AssigneeAgentID))
			if agentID == "" {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: "mention requires agentId or issue assigneeAgentId"})
				continue
			}
			if err := h.validateAgentBelongsToIssueWorkspace(ctx, current, agentID); err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			_ = h.issues.AddActivityEvent(ctx, current.WorkspaceID, "issue", current.ID, "issue.agent_mentioned", "user", optionalString(userID), "Agent mentioned", firstNonEmpty(derefIssueString(action.Description), "Agent mention recorded"), map[string]interface{}{"agentId": agentID})
			_ = h.addSystemIssueComment(ctx, current, "Agent mention recorded.")
			results = append(results, issueCommentActionResult{Type: actionType, Status: "ok", Message: "Agent mention recorded"})
		case "request_approval":
			title := firstNonEmpty(derefIssueString(action.Title), current.Title)
			approval, err := h.issues.CreateApproval(ctx, store.CreateApprovalInput{
				WorkspaceID:       current.WorkspaceID,
				Title:             title,
				Description:       firstOptionalNonEmpty(trimOptionalString(action.Description), trimOptionalString(&body)),
				RequestedByUserID: optionalString(userID),
			})
			if err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			if err := h.issues.LinkApproval(ctx, current.WorkspaceID, current.ID, approval.ID, optionalString(userID)); err != nil {
				results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: err.Error()})
				continue
			}
			_, _ = h.issues.AddApprovalEvent(ctx, store.CreateApprovalEventInput{
				ApprovalID:  approval.ID,
				WorkspaceID: approval.WorkspaceID,
				Action:      "approval.requested",
				ActorType:   "user",
				ActorID:     optionalString(userID),
				Note:        trimOptionalString(action.DecisionNote),
				Metadata:    map[string]interface{}{"issueId": current.ID, "status": approval.Status},
			})
			_ = h.issues.AddActivityEvent(ctx, current.WorkspaceID, "issue", current.ID, "issue.approval_requested", "user", optionalString(userID), "Approval requested", approval.Title, map[string]interface{}{"approvalId": approval.ID, "status": approval.Status})
			_ = h.addSystemIssueComment(ctx, current, "Approval requested.")
			results = append(results, issueCommentActionResult{Type: actionType, Status: "ok", Message: "Approval requested", ApprovalID: &approval.ID})
		default:
			results = append(results, issueCommentActionResult{Type: actionType, Status: "error", Message: "unsupported comment action"})
		}
	}
	return results, current
}

func (h *IssueHandler) reopenIssueFromComment(ctx context.Context, issue *model.Issue, userID string) (*model.Issue, bool, error) {
	if issue == nil {
		return nil, false, nil
	}
	switch issue.Status {
	case "done", "cancelled":
		status := "todo"
		updated, err := h.issues.Update(ctx, issue.ID, store.UpdateIssueInput{Status: &status})
		if err != nil {
			return issue, false, err
		}
		_ = h.issues.AddActivityEvent(ctx, issue.WorkspaceID, "issue", issue.ID, "issue.reopened", "user", optionalString(userID), "Issue reopened", issue.Identifier, map[string]interface{}{"status": status})
		return updated, true, nil
	default:
		return issue, false, nil
	}
}

func (h *IssueHandler) addSystemIssueComment(ctx context.Context, issue *model.Issue, body string) error {
	if issue == nil || strings.TrimSpace(body) == "" {
		return nil
	}
	_, err := h.issues.AddComment(ctx, store.CreateIssueCommentInput{
		WorkspaceID: issue.WorkspaceID,
		IssueID:     issue.ID,
		Body:        strings.TrimSpace(body),
	})
	return err
}

func (h *IssueHandler) validateAgentBelongsToIssueWorkspace(ctx context.Context, issue *model.Issue, agentID string) error {
	return h.validateAgentBelongsToWorkspace(ctx, issue.WorkspaceID, agentID)
}

func (h *IssueHandler) validateAgentBelongsToWorkspace(ctx context.Context, workspaceID, agentID string) error {
	agent, err := h.agents.GetByID(ctx, agentID)
	if err != nil {
		return err
	}
	if agent == nil {
		return fmt.Errorf("agent not found")
	}
	if strings.TrimSpace(workspaceID) != "" && agent.WorkspaceID != workspaceID {
		return fmt.Errorf("agent does not belong to the issue workspace")
	}
	return nil
}

func (h *IssueHandler) validateApprovalBelongsToIssueWorkspace(ctx context.Context, issue *model.Issue, approvalID string) error {
	approval, err := h.issues.GetApprovalByID(ctx, approvalID)
	if err != nil {
		return err
	}
	if approval == nil {
		return fmt.Errorf("approval not found")
	}
	if issue != nil && approval.WorkspaceID != issue.WorkspaceID {
		return fmt.Errorf("approval does not belong to the issue workspace")
	}
	return nil
}
