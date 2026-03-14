package model

import "time"

type Org struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	AvatarURL *string   `json:"avatarUrl,omitempty"`
	Plan      string    `json:"plan"`
	CreatedAt time.Time `json:"createdAt"`
}

type OrgMember struct {
	ID       string    `json:"id"`
	UserID   string    `json:"userId"`
	OrgID    string    `json:"orgId"`
	Role     string    `json:"role"`
	User     User      `json:"user"`
	JoinedAt time.Time `json:"joinedAt"`
}

type Workspace struct {
	ID          string    `json:"id"`
	OrgID       string    `json:"orgId"`
	Name        string    `json:"name"`
	Slug        string    `json:"slug"`
	Emoji       string    `json:"emoji"`
	Description *string   `json:"description,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}
