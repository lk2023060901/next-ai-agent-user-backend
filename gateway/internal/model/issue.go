package model

import "time"

type IssueLabel struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type Issue struct {
	ID                    string       `json:"id"`
	WorkspaceID           string       `json:"workspaceId"`
	ProjectID             *string      `json:"projectId,omitempty"`
	GoalID                *string      `json:"goalId,omitempty"`
	ParentID              *string      `json:"parentId,omitempty"`
	Title                 string       `json:"title"`
	Description           *string      `json:"description,omitempty"`
	Status                string       `json:"status"`
	Priority              string       `json:"priority"`
	AssigneeAgentID       *string      `json:"assigneeAgentId,omitempty"`
	AssigneeUserID        *string      `json:"assigneeUserId,omitempty"`
	CheckoutRunID         *string      `json:"checkoutRunId,omitempty"`
	ExecutionRunID        *string      `json:"executionRunId,omitempty"`
	ExecutionAgentNameKey *string      `json:"executionAgentNameKey,omitempty"`
	ExecutionLockedAt     *time.Time   `json:"executionLockedAt,omitempty"`
	CreatedByAgentID      *string      `json:"createdByAgentId,omitempty"`
	CreatedByUserID       *string      `json:"createdByUserId,omitempty"`
	IssueNumber           int          `json:"issueNumber"`
	Identifier            string       `json:"identifier"`
	RequestDepth          int          `json:"requestDepth"`
	BillingCode           *string      `json:"billingCode,omitempty"`
	StartedAt             *time.Time   `json:"startedAt,omitempty"`
	CompletedAt           *time.Time   `json:"completedAt,omitempty"`
	CancelledAt           *time.Time   `json:"cancelledAt,omitempty"`
	HiddenAt              *time.Time   `json:"hiddenAt,omitempty"`
	MyLastTouchAt         *time.Time   `json:"myLastTouchAt,omitempty"`
	LastExternalCommentAt *time.Time   `json:"lastExternalCommentAt,omitempty"`
	IsUnreadForMe         bool         `json:"isUnreadForMe"`
	CreatedAt             time.Time    `json:"createdAt"`
	UpdatedAt             time.Time    `json:"updatedAt"`
	LabelIDs              []string     `json:"labelIds,omitempty"`
	Labels                []IssueLabel `json:"labels,omitempty"`
}

type IssueAncestor struct {
	ID              string  `json:"id"`
	Identifier      string  `json:"identifier"`
	Title           string  `json:"title"`
	Description     *string `json:"description,omitempty"`
	Status          string  `json:"status"`
	Priority        string  `json:"priority"`
	AssigneeAgentID *string `json:"assigneeAgentId,omitempty"`
	AssigneeUserID  *string `json:"assigneeUserId,omitempty"`
	ProjectID       *string `json:"projectId,omitempty"`
	GoalID          *string `json:"goalId,omitempty"`
}

type IssueComment struct {
	ID            string    `json:"id"`
	WorkspaceID   string    `json:"workspaceId"`
	IssueID       string    `json:"issueId"`
	AuthorAgentID *string   `json:"authorAgentId,omitempty"`
	AuthorUserID  *string   `json:"authorUserId,omitempty"`
	Body          string    `json:"body"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type IssueReadState struct {
	WorkspaceID string    `json:"workspaceId"`
	IssueID     string    `json:"issueId"`
	UserID      string    `json:"userId"`
	LastReadAt  time.Time `json:"lastReadAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type IssueAttachment struct {
	ID               string    `json:"id"`
	WorkspaceID      string    `json:"workspaceId"`
	IssueID          string    `json:"issueId"`
	IssueCommentID   *string   `json:"issueCommentId,omitempty"`
	ContentType      string    `json:"contentType"`
	ByteSize         int64     `json:"byteSize"`
	SHA256           string    `json:"sha256"`
	OriginalFilename *string   `json:"originalFilename,omitempty"`
	CreatedByAgentID *string   `json:"createdByAgentId,omitempty"`
	CreatedByUserID  *string   `json:"createdByUserId,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
	ContentPath      string    `json:"contentPath,omitempty"`
}

type IssueApproval struct {
	ID                 string     `json:"id"`
	WorkspaceID        string     `json:"workspaceId"`
	IssueID            string     `json:"issueId"`
	ApprovalID         string     `json:"approvalId"`
	Title              string     `json:"title"`
	Description        *string    `json:"description,omitempty"`
	Status             string     `json:"status"`
	RequestedByUserID  *string    `json:"requestedByUserId,omitempty"`
	RequestedByAgentID *string    `json:"requestedByAgentId,omitempty"`
	ResolvedByUserID   *string    `json:"resolvedByUserId,omitempty"`
	DecisionNote       *string    `json:"decisionNote,omitempty"`
	ResolvedAt         *time.Time `json:"resolvedAt,omitempty"`
	CreatedByUserID    *string    `json:"createdByUserId,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

type Approval struct {
	ID                 string     `json:"id"`
	WorkspaceID        string     `json:"workspaceId"`
	Title              string     `json:"title"`
	Description        *string    `json:"description,omitempty"`
	Status             string     `json:"status"`
	RequestedByUserID  *string    `json:"requestedByUserId,omitempty"`
	RequestedByAgentID *string    `json:"requestedByAgentId,omitempty"`
	ResolvedByUserID   *string    `json:"resolvedByUserId,omitempty"`
	DecisionNote       *string    `json:"decisionNote,omitempty"`
	ResolvedAt         *time.Time `json:"resolvedAt,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

type ApprovalEvent struct {
	ID          string                 `json:"id"`
	ApprovalID  string                 `json:"approvalId"`
	WorkspaceID string                 `json:"workspaceId"`
	Action      string                 `json:"action"`
	ActorType   string                 `json:"actorType"`
	ActorID     *string                `json:"actorId,omitempty"`
	Note        *string                `json:"note,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt   time.Time              `json:"createdAt"`
}

type IssueRun struct {
	ID                 string     `json:"id"`
	IssueID            string     `json:"issueId"`
	WorkspaceID        string     `json:"workspaceId"`
	AgentID            string     `json:"agentId"`
	ExecutionMode      string     `json:"executionMode"`
	ExecutorName       *string    `json:"executorName,omitempty"`
	ExecutorHostname   *string    `json:"executorHostname,omitempty"`
	ExecutorPlatform   *string    `json:"executorPlatform,omitempty"`
	Status             string     `json:"status"`
	TriggerSource      string     `json:"triggerSource"`
	TriggerDetail      *string    `json:"triggerDetail,omitempty"`
	RequestedByUserID  *string    `json:"requestedByUserId,omitempty"`
	RequestedByAgentID *string    `json:"requestedByAgentId,omitempty"`
	ErrorMessage       *string    `json:"errorMessage,omitempty"`
	ResultText         *string    `json:"resultText,omitempty"`
	ResultCommentID    *string    `json:"resultCommentId,omitempty"`
	HeartbeatAt        *time.Time `json:"heartbeatAt,omitempty"`
	TimeoutAt          *time.Time `json:"timeoutAt,omitempty"`
	StartedAt          *time.Time `json:"startedAt,omitempty"`
	FinishedAt         *time.Time `json:"finishedAt,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

type IssueRunEvent struct {
	ID          string                 `json:"id"`
	RunID       string                 `json:"runId"`
	IssueID     string                 `json:"issueId"`
	WorkspaceID string                 `json:"workspaceId"`
	Seq         int                    `json:"seq"`
	EventType   string                 `json:"eventType"`
	Title       *string                `json:"title,omitempty"`
	Summary     *string                `json:"summary,omitempty"`
	Payload     map[string]interface{} `json:"payload"`
	CreatedAt   time.Time              `json:"createdAt"`
}

type IssueTimelineEvent struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	EntityType  string                 `json:"entityType"`
	EntityID    string                 `json:"entityId"`
	Title       string                 `json:"title"`
	Description string                 `json:"description"`
	CreatedAt   time.Time              `json:"createdAt"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}
