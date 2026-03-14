package model

import "time"

type Channel struct {
	ID                  string     `json:"id"`
	WorkspaceID         string     `json:"workspaceId"`
	Type                string     `json:"type"`
	Name                string     `json:"name"`
	Status              string     `json:"status"`
	ConnectedChannels   *int       `json:"connectedChannels,omitempty"`
	LastActiveAt        *time.Time `json:"lastActiveAt,omitempty"`
	RealtimeConnected   bool       `json:"realtimeConnected"`
	ConnectionState     *string    `json:"connectionState,omitempty"`
	ConnectionMode      *string    `json:"connectionMode,omitempty"`
	LastConnectedAt     *time.Time `json:"lastConnectedAt,omitempty"`
	ConnectionLastError *string    `json:"connectionLastError,omitempty"`
	DefaultAgentID      *string    `json:"defaultAgentId,omitempty"`
	Config              map[string]string `json:"config"`
	CreatedAt           time.Time  `json:"createdAt"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}

type ChannelMessage struct {
	ID           string     `json:"id"`
	ChannelID    string     `json:"channelId"`
	Direction    string     `json:"direction"`
	SenderName   string     `json:"senderName"`
	Content      string     `json:"content"`
	AgentID      *string    `json:"agentId,omitempty"`
	AgentName    *string    `json:"agentName,omitempty"`
	Status       string     `json:"status"`
	ErrorDetail  *string    `json:"errorDetail,omitempty"`
	ProcessingMs *int       `json:"processingMs,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

type RoutingRule struct {
	ID              string `json:"id"`
	ChannelID       string `json:"channelId"`
	Priority        int    `json:"priority"`
	Field           string `json:"field"`
	Operator        string `json:"operator"`
	Value           string `json:"value"`
	TargetAgentID   string `json:"targetAgentId"`
	TargetAgentName string `json:"targetAgentName"`
	Enabled         bool   `json:"enabled"`
}

type ChannelStats struct {
	TodayInbound  int `json:"todayInbound"`
	TodayOutbound int `json:"todayOutbound"`
	AvgResponseMs int `json:"avgResponseMs"`
	ActiveUsers   int `json:"activeUsers"`
	FailedMessages int `json:"failedMessages"`
	HourlyTrend   []HourlyTrendItem `json:"hourlyTrend"`
}

type HourlyTrendItem struct {
	Hour     int `json:"hour"`
	Inbound  int `json:"inbound"`
	Outbound int `json:"outbound"`
}
