package store

import (
	"context"
	"fmt"
	"time"

	"github.com/nextai-agent/gateway/internal/model"
)

type DashboardStore struct {
	db *DB
}

func NewDashboardStore(db *DB) *DashboardStore {
	return &DashboardStore{db: db}
}

func (s *DashboardStore) GetStats(ctx context.Context, orgID string) (*model.DashboardStats, error) {
	today := time.Now().Truncate(24 * time.Hour)
	weekAgo := today.AddDate(0, 0, -7)

	// Active agents
	var activeAgents int
	s.db.QueryRow(ctx,
		Select("COUNT(*)").From("agents a").
			Join("workspaces w ON w.id = a.workspace_id").
			Where("w.org_id = ? AND a.status != 'idle'", orgID),
	).Scan(&activeAgents)

	var totalAgents int
	s.db.QueryRow(ctx,
		Select("COUNT(*)").From("agents a").
			Join("workspaces w ON w.id = a.workspace_id").
			Where("w.org_id = ?", orgID),
	).Scan(&totalAgents)

	// Today's sessions
	var todaySessions int
	s.db.QueryRow(ctx,
		Select("COUNT(*)").From("sessions s").
			Join("workspaces w ON w.id = s.workspace_id").
			Where("w.org_id = ? AND s.created_at >= ?", orgID, today),
	).Scan(&todaySessions)

	// Token usage (from usage_records)
	var tokenUsage int
	s.db.QueryRow(ctx,
		Select("COALESCE(SUM(input_tokens + output_tokens), 0)").
			From("usage_records").
			Where("org_id = ? AND created_at >= ?", orgID, today),
	).Scan(&tokenUsage)

	// Completed tasks are issue completions, not chat messages.
	var completedTasks int
	s.db.QueryRow(ctx,
		Select("COUNT(*)").From("issues i").
			Join("workspaces w ON w.id = i.workspace_id").
			Where("w.org_id = ? AND i.status = 'done' AND i.completed_at >= ?", orgID, today),
	).Scan(&completedTasks)

	// Sparklines (7 days)
	agentSparkline := s.dailyCounts(ctx, orgID, weekAgo,
		"SELECT d::date, 0 FROM generate_series($2::date, CURRENT_DATE, '1 day') d", nil)
	sessionSparkline := s.dailyCountsQuery(ctx,
		"SELECT d::date, COUNT(s.id) FROM generate_series($2::date, CURRENT_DATE, '1 day') d "+
			"LEFT JOIN sessions s ON s.created_at::date = d::date AND s.workspace_id IN (SELECT id FROM workspaces WHERE org_id = $1) "+
			"GROUP BY d::date ORDER BY d::date",
		orgID, weekAgo)
	tokenSparkline := s.dailyCountsQuery(ctx,
		"SELECT d::date, COALESCE(SUM(u.input_tokens + u.output_tokens), 0) FROM generate_series($2::date, CURRENT_DATE, '1 day') d "+
			"LEFT JOIN usage_records u ON u.created_at::date = d::date AND u.org_id = $1 "+
			"GROUP BY d::date ORDER BY d::date",
		orgID, weekAgo)
	taskSparkline := s.dailyCountsQuery(ctx,
		"SELECT d::date, COUNT(i.id) FROM generate_series($2::date, CURRENT_DATE, '1 day') d "+
			"LEFT JOIN issues i ON i.completed_at::date = d::date AND i.status = 'done' AND i.workspace_id IN (SELECT id FROM workspaces WHERE org_id = $1) "+
			"GROUP BY d::date ORDER BY d::date",
		orgID, weekAgo)

	return &model.DashboardStats{
		ActiveAgents:   model.StatMetric{Value: totalAgents, Trend: 0, Sparkline: agentSparkline},
		TodaySessions:  model.StatMetric{Value: todaySessions, Trend: 0, Sparkline: sessionSparkline},
		TokenUsage:     model.StatMetric{Value: tokenUsage, Trend: 0, Sparkline: tokenSparkline},
		CompletedTasks: model.StatMetric{Value: completedTasks, Trend: 0, Sparkline: taskSparkline},
	}, nil
}

func (s *DashboardStore) GetWorkload(ctx context.Context, orgID string) ([]model.AgentWorkload, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT a.id, a.name, a.role, COUNT(i.id)
		 FROM agents a
		 JOIN workspaces w ON w.id = a.workspace_id
		 LEFT JOIN issues i ON i.assignee_agent_id = a.id AND i.status NOT IN ('done', 'cancelled')
		 WHERE w.org_id = $1
		 GROUP BY a.id, a.name, a.role
		 ORDER BY COUNT(i.id) DESC, a.name ASC`, orgID)
	if err != nil {
		return nil, fmt.Errorf("get workload: %w", err)
	}
	defer rows.Close()

	var result []model.AgentWorkload
	for rows.Next() {
		var w model.AgentWorkload
		rows.Scan(&w.AgentID, &w.AgentName, &w.Role, &w.TaskCount)
		result = append(result, w)
	}
	return result, nil
}

func (s *DashboardStore) GetActivities(ctx context.Context, orgID string) ([]model.ActivityEvent, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT ae.id, ae.action, ae.title, ae.description, ae.created_at,
		        COALESCE(u.name, a.name, ae.actor_type) AS actor_name,
		        COALESCE(u.avatar_url, a.avatar, '') AS actor_avatar
		 FROM activity_events ae
		 JOIN workspaces w ON w.id = ae.workspace_id
		 LEFT JOIN users u ON ae.actor_type = 'user' AND u.id = ae.actor_id
		 LEFT JOIN agents a ON ae.actor_type = 'agent' AND a.id = ae.actor_id
		 WHERE w.org_id = $1
		 ORDER BY ae.created_at DESC LIMIT 20`, orgID)
	if err != nil {
		return nil, fmt.Errorf("get activities: %w", err)
	}
	defer rows.Close()

	var events []model.ActivityEvent
	for rows.Next() {
		var e model.ActivityEvent
		var createdAt time.Time
		var actorAvatar string
		rows.Scan(&e.ID, &e.Type, &e.Title, &e.Description, &createdAt, &e.ActorName, &actorAvatar)
		e.Timestamp = createdAt.Format(time.RFC3339)
		e.ActorAvatar = actorAvatar
		events = append(events, e)
	}
	return events, nil
}

func (s *DashboardStore) GetTokenStats(ctx context.Context, orgID string) (*model.TokenStats, error) {
	return &model.TokenStats{
		Providers:     []model.ProviderUsage{},
		Models:        []model.ModelUsage{},
		Trend:         []model.DailyTokenUsage{},
		ProviderTrend: []model.DailyBreakdownEntry{},
		ModelTrend:    []model.DailyBreakdownEntry{},
	}, nil
}

func (s *DashboardStore) dailyCounts(ctx context.Context, orgID string, since time.Time, query string, _ interface{}) []int {
	result := make([]int, 7)
	return result
}

func (s *DashboardStore) dailyCountsQuery(ctx context.Context, query string, orgID string, since time.Time) []int {
	rows, err := s.db.Pool.Query(ctx, query, orgID, since)
	if err != nil {
		return make([]int, 7)
	}
	defer rows.Close()

	var result []int
	for rows.Next() {
		var d time.Time
		var count int
		rows.Scan(&d, &count)
		result = append(result, count)
	}
	if len(result) == 0 {
		return make([]int, 7)
	}
	return result
}
