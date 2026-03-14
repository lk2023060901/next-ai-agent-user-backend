package model

type StatMetric struct {
	Value     int       `json:"value"`
	Trend     float64   `json:"trend"`
	Sparkline []int     `json:"sparkline"`
}

type DashboardStats struct {
	ActiveAgents   StatMetric `json:"activeAgents"`
	TodaySessions  StatMetric `json:"todaySessions"`
	TokenUsage     StatMetric `json:"tokenUsage"`
	CompletedTasks StatMetric `json:"completedTasks"`
}

type DailyMessageStats struct {
	Date     string `json:"date"`
	Inbound  int    `json:"inbound"`
	Outbound int    `json:"outbound"`
}

type AgentWorkload struct {
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
	Role      string `json:"role"`
	TaskCount int    `json:"taskCount"`
}

type ActivityEvent struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Timestamp   string `json:"timestamp"`
	ActorName   string `json:"actorName"`
	ActorAvatar string `json:"actorAvatar"`
}

type TokenStats struct {
	Providers     []ProviderUsage      `json:"providers"`
	Models        []ModelUsage         `json:"models"`
	Trend         []DailyTokenUsage    `json:"trend"`
	ProviderTrend []DailyBreakdownEntry `json:"providerTrend"`
	ModelTrend    []DailyBreakdownEntry `json:"modelTrend"`
}

type ProviderUsage struct {
	Provider   string  `json:"provider"`
	Tokens     int     `json:"tokens"`
	Percentage float64 `json:"percentage"`
	Color      string  `json:"color"`
}

type ModelUsage struct {
	Model      string  `json:"model"`
	Provider   string  `json:"provider"`
	Tokens     int     `json:"tokens"`
	Percentage float64 `json:"percentage"`
	Color      string  `json:"color"`
}

type DailyTokenUsage struct {
	Date         string `json:"date"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
}

type DailyBreakdownEntry map[string]interface{}
