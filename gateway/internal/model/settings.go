package model

import "time"

type AIProvider struct {
	ID           string    `json:"id"`
	WorkspaceID  string    `json:"workspaceId,omitempty"`
	Name         string    `json:"name"`
	Type         string    `json:"type"`
	Icon         string    `json:"icon"`
	BaseURL      string    `json:"baseUrl"`
	AuthMethod   string    `json:"authMethod"`
	SupportsOAuth bool     `json:"supportsOAuth"`
	Enabled      bool      `json:"enabled"`
	Status       string    `json:"status"`
	ModelCount   int       `json:"modelCount"`
	CreatedAt    time.Time `json:"createdAt"`
}

type AIModel struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	DisplayName   string   `json:"displayName"`
	ContextWindow int      `json:"contextWindow"`
	MaxOutput     int      `json:"maxOutput"`
	InputPrice    float64  `json:"inputPrice"`
	OutputPrice   float64  `json:"outputPrice"`
	Capabilities  []string `json:"capabilities"`
	Enabled       bool     `json:"enabled"`
}

type ModelSeries struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	Models []AIModel `json:"models"`
}

type FlatModel struct {
	ModelID       string   `json:"modelId"`
	Name          string   `json:"name"`
	DisplayName   string   `json:"displayName"`
	ProviderName  string   `json:"providerName"`
	ProviderIcon  string   `json:"providerIcon"`
	ProviderType  string   `json:"providerType"`
	Capabilities  []string `json:"capabilities"`
	ContextWindow int      `json:"contextWindow"`
	InputPrice    float64  `json:"inputPrice"`
	OutputPrice   float64  `json:"outputPrice"`
}

type WorkspaceSettings struct {
	ID                  string  `json:"id"`
	Name                string  `json:"name"`
	Description         string  `json:"description"`
	DefaultModel        string  `json:"defaultModel"`
	DefaultTemperature  float64 `json:"defaultTemperature"`
	MaxTokensPerRequest int     `json:"maxTokensPerRequest"`
	AssistantModelID    *string `json:"assistantModelId,omitempty"`
	FastModelID         *string `json:"fastModelId,omitempty"`
	CodeModelID         *string `json:"codeModelId,omitempty"`
	AgentModelID        *string `json:"agentModelId,omitempty"`
	SubAgentModelID     *string `json:"subAgentModelId,omitempty"`
}

type ApiKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	FullKey    string     `json:"fullKey,omitempty"`
	Status     string     `json:"status"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
}
