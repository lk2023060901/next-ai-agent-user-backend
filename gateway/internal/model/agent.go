package model

import "time"

type Agent struct {
	ID             string   `json:"id"`
	WorkspaceID    string   `json:"workspaceId"`
	Name           string   `json:"name"`
	Role           string   `json:"role"`
	Status         string   `json:"status"`
	Model          string   `json:"model"`
	ModelID        *string  `json:"modelId,omitempty"`
	SystemPrompt   *string  `json:"systemPrompt,omitempty"`
	Description    *string  `json:"description,omitempty"`
	Avatar         *string  `json:"avatar,omitempty"`
	Color          *string  `json:"color,omitempty"`
	Identifier     *string  `json:"identifier,omitempty"`
	ConfigJSON     *string  `json:"configJson,omitempty"`
	KnowledgeBases []string `json:"knowledgeBases,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}
