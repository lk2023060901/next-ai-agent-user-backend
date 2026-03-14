package model

import "time"

type Session struct {
	ID            string     `json:"id"`
	WorkspaceID   string     `json:"workspaceId"`
	Title         string     `json:"title"`
	Status        string     `json:"status"`
	MessageCount  int        `json:"messageCount"`
	IsPinned      bool       `json:"isPinned"`
	PinnedAt      *time.Time `json:"pinnedAt,omitempty"`
	LastMessageAt *time.Time `json:"lastMessageAt,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

type Message struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	AgentID   *string   `json:"agentId,omitempty"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
}

type MessagePage struct {
	Messages           []Message `json:"messages"`
	HasMore            bool      `json:"hasMore"`
	NextBeforeMessageID *string  `json:"nextBeforeMessageId,omitempty"`
}
