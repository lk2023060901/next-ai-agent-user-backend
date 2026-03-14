package model

import "time"

type Workflow struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Description *string   `json:"description,omitempty"`
	Status      string    `json:"status"`
	SpecVersion string    `json:"specVersion"`
	Revision    int       `json:"revision"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type WorkflowRunRecord struct {
	RunID                string     `json:"runId"`
	WorkflowID           string     `json:"workflowId"`
	WorkflowRevision     *int       `json:"workflowRevision,omitempty"`
	Status               string     `json:"status"`
	StartedAt            time.Time  `json:"startedAt"`
	CompletedAt          *time.Time `json:"completedAt,omitempty"`
	DurationMs           *int       `json:"durationMs,omitempty"`
	CurrentNodeID        *string    `json:"currentNodeId,omitempty"`
	PausedAtNodeID       *string    `json:"pausedAtNodeId,omitempty"`
	PausedBreakpointType *string    `json:"pausedBreakpointType,omitempty"`
	ErrorMessage         *string    `json:"errorMessage,omitempty"`
	TriggeredBy          *string    `json:"triggeredBy,omitempty"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

type WorkflowRunOutput struct {
	ID          string      `json:"id"`
	RunID       string      `json:"runId"`
	NodeID      string      `json:"nodeId"`
	PinID       string      `json:"pinId"`
	Kind        string      `json:"kind"`
	Value       interface{} `json:"value"`
	ContentURL  *string     `json:"contentUrl,omitempty"`
	MimeType    *string     `json:"mimeType,omitempty"`
	MediaURL    *string     `json:"mediaUrl,omitempty"`
	StoragePath *string     `json:"storagePath,omitempty"`
	FileName    *string     `json:"fileName,omitempty"`
	SizeBytes   *int64      `json:"sizeBytes,omitempty"`
	CreatedAt   time.Time   `json:"createdAt"`
	UpdatedAt   time.Time   `json:"updatedAt"`
}
