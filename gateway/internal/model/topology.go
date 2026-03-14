package model

import "time"

type AgentConnection struct {
	ID            string  `json:"id"`
	SourceAgentID string  `json:"sourceAgentId"`
	TargetAgentID string  `json:"targetAgentId"`
	MessageCount  int     `json:"messageCount"`
	Label         *string `json:"label,omitempty"`
	Active        bool    `json:"active"`
}

type AgentTask struct {
	ID              string     `json:"id"`
	Title           string     `json:"title"`
	Description     string     `json:"description"`
	Status          string     `json:"status"`
	AssignedAgentID string     `json:"assignedAgentId"`
	Progress        int        `json:"progress"`
	CreatedAt       time.Time  `json:"createdAt"`
	StartedAt       *time.Time `json:"startedAt,omitempty"`
	CompletedAt     *time.Time `json:"completedAt,omitempty"`
	Duration        *int       `json:"duration,omitempty"`
	Dependencies    []string   `json:"dependencies,omitempty"`
}

type TopologyData struct {
	Agents      []Agent           `json:"agents"`
	Connections []AgentConnection `json:"connections"`
	Tasks       []AgentTask       `json:"tasks"`
}
