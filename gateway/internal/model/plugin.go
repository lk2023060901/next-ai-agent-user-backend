package model

import "time"

type Plugin struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	DisplayName     string   `json:"displayName"`
	Description     string   `json:"description"`
	LongDescription *string  `json:"longDescription,omitempty"`
	Author          string   `json:"author"`
	AuthorAvatar    *string  `json:"authorAvatar,omitempty"`
	Icon            string   `json:"icon"`
	Type            string   `json:"type"`
	Version         string   `json:"version"`
	PricingModel    string   `json:"pricingModel"`
	Price           *float64 `json:"price,omitempty"`
	MonthlyPrice    *float64 `json:"monthlyPrice,omitempty"`
	TrialDays       *int     `json:"trialDays,omitempty"`
	Rating          float64  `json:"rating"`
	ReviewCount     int      `json:"reviewCount"`
	InstallCount    int      `json:"installCount"`
	FavoriteCount   int      `json:"favoriteCount"`
	IsFavorited     bool     `json:"isFavorited"`
	Tags            []string `json:"tags"`
	Permissions     []string `json:"permissions"`
	Screenshots     []string `json:"screenshots"`
	PublishedAt     time.Time `json:"publishedAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type InstalledPlugin struct {
	ID          string                 `json:"id"`
	WorkspaceID string                 `json:"workspaceId"`
	PluginID    string                 `json:"pluginId"`
	Plugin      Plugin                 `json:"plugin"`
	Status      string                 `json:"status"`
	Config      map[string]interface{} `json:"config"`
	InstalledAt time.Time              `json:"installedAt"`
	InstalledBy string                 `json:"installedBy"`
}

type PluginReview struct {
	ID         string    `json:"id"`
	PluginID   string    `json:"pluginId"`
	AuthorName string    `json:"authorName"`
	Rating     int       `json:"rating"`
	Content    string    `json:"content"`
	CreatedAt  time.Time `json:"createdAt"`
}
