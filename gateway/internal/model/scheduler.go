package model

import "time"

type ScheduledTask struct {
	ID                string     `json:"id"`
	WorkspaceID       string     `json:"workspaceId"`
	Name              string     `json:"name"`
	Description       *string    `json:"description,omitempty"`
	Instruction       string     `json:"instruction"`
	CronExpression    string     `json:"cronExpression"`
	CronDescription   string     `json:"cronDescription"`
	ScheduleType      *string    `json:"scheduleType,omitempty"`
	Interval          *int       `json:"interval,omitempty"`
	IntervalUnit      *string    `json:"intervalUnit,omitempty"`
	TargetAgentID     *string    `json:"targetAgentId,omitempty"`
	TargetAgentName   *string    `json:"targetAgentName,omitempty"`
	Enabled           bool       `json:"enabled"`
	Status            string     `json:"status"`
	LastRunAt         *time.Time `json:"lastRunAt,omitempty"`
	NextRunAt         *time.Time `json:"nextRunAt,omitempty"`
	RunCount          int        `json:"runCount"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

type TaskExecution struct {
	ID          string     `json:"id"`
	TaskID      string     `json:"taskId"`
	TaskName    string     `json:"taskName"`
	Status      string     `json:"status"`
	StartedAt   time.Time  `json:"startedAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	DurationMs  *int       `json:"durationMs,omitempty"`
	LogSummary  *string    `json:"logSummary,omitempty"`
}
