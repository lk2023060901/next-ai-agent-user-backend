package model

import "time"

type MonitoringRun struct {
	RunID            string     `json:"runId"`
	IssueID          string     `json:"issueId"`
	WorkspaceID      string     `json:"workspaceId"`
	IssueIdentifier  string     `json:"issueIdentifier"`
	IssueTitle       string     `json:"issueTitle"`
	IssueStatus      string     `json:"issueStatus"`
	Summary          string     `json:"summary"`
	AgentID          string     `json:"agentId"`
	AgentName        string     `json:"agentName"`
	Status           string     `json:"status"`
	ExecutionMode    string     `json:"executionMode"`
	ExecutorName     *string    `json:"executorName,omitempty"`
	ExecutorHostname *string    `json:"executorHostname,omitempty"`
	ExecutorPlatform *string    `json:"executorPlatform,omitempty"`
	TriggerSource    string     `json:"triggerSource"`
	TriggerDetail    *string    `json:"triggerDetail,omitempty"`
	CurrentStep      *string    `json:"currentStep,omitempty"`
	LastEventType    *string    `json:"lastEventType,omitempty"`
	LastEventSummary *string    `json:"lastEventSummary,omitempty"`
	LastEventAt      *time.Time `json:"lastEventAt,omitempty"`
	ErrorMessage     *string    `json:"errorMessage,omitempty"`
	ResultText       *string    `json:"resultText,omitempty"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
	FinishedAt       *time.Time `json:"finishedAt,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}
