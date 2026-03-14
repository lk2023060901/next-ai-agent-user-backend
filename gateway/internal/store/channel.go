package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

type ChannelStore struct {
	db *DB
}

func NewChannelStore(db *DB) *ChannelStore {
	return &ChannelStore{db: db}
}

var chCols = []string{
	"id", "workspace_id", "type", "name", "status", "connected_channels",
	"last_active_at", "realtime_connected", "connection_state", "connection_mode",
	"last_connected_at", "connection_last_error", "default_agent_id", "config",
	"created_at", "updated_at",
}

func (s *ChannelStore) List(ctx context.Context, workspaceID string) ([]model.Channel, error) {
	rows, err := s.db.Query(ctx,
		Select(chCols...).From("channels").Where("workspace_id = ?", workspaceID).OrderBy("created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	defer rows.Close()
	return scanChannels(rows)
}

func (s *ChannelStore) Create(ctx context.Context, ch *model.Channel) (*model.Channel, error) {
	configJSON, _ := json.Marshal(ch.Config)
	err := s.db.QueryRow(ctx,
		Insert("channels").
			Columns("workspace_id", "type", "name", "status", "default_agent_id", "config").
			Values(ch.WorkspaceID, ch.Type, ch.Name, "disconnected", ch.DefaultAgentID, configJSON).
			Suffix("RETURNING "+JoinCols(chCols)),
	).Scan(&ch.ID, &ch.WorkspaceID, &ch.Type, &ch.Name, &ch.Status, &ch.ConnectedChannels,
		&ch.LastActiveAt, &ch.RealtimeConnected, &ch.ConnectionState, &ch.ConnectionMode,
		&ch.LastConnectedAt, &ch.ConnectionLastError, &ch.DefaultAgentID, &configJSON,
		&ch.CreatedAt, &ch.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create channel: %w", err)
	}
	json.Unmarshal(configJSON, &ch.Config)
	return ch, nil
}

func (s *ChannelStore) Update(ctx context.Context, id string, fields map[string]interface{}) (*model.Channel, error) {
	b := SetFields(Update("channels"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", id).
		Suffix("RETURNING " + JoinCols(chCols))
	ch := &model.Channel{}
	var configJSON []byte
	err := s.db.QueryRow(ctx, b).Scan(&ch.ID, &ch.WorkspaceID, &ch.Type, &ch.Name, &ch.Status,
		&ch.ConnectedChannels, &ch.LastActiveAt, &ch.RealtimeConnected, &ch.ConnectionState,
		&ch.ConnectionMode, &ch.LastConnectedAt, &ch.ConnectionLastError, &ch.DefaultAgentID,
		&configJSON, &ch.CreatedAt, &ch.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("update channel: %w", err)
	}
	json.Unmarshal(configJSON, &ch.Config)
	return ch, nil
}

func (s *ChannelStore) Delete(ctx context.Context, id string) error {
	return s.db.Exec(ctx, Delete("channels").Where("id = ?", id))
}

// Stats

func (s *ChannelStore) GetStats(ctx context.Context, channelID string) (*model.ChannelStats, error) {
	today := time.Now().Truncate(24 * time.Hour)
	stats := &model.ChannelStats{}

	s.db.QueryRow(ctx, Select("COUNT(*)").From("channel_messages").
		Where("channel_id = ? AND direction = 'inbound' AND created_at >= ?", channelID, today)).Scan(&stats.TodayInbound)
	s.db.QueryRow(ctx, Select("COUNT(*)").From("channel_messages").
		Where("channel_id = ? AND direction = 'outbound' AND created_at >= ?", channelID, today)).Scan(&stats.TodayOutbound)
	s.db.QueryRow(ctx, Select("COALESCE(AVG(processing_ms), 0)").From("channel_messages").
		Where("channel_id = ? AND direction = 'outbound' AND created_at >= ?", channelID, today)).Scan(&stats.AvgResponseMs)
	s.db.QueryRow(ctx, Select("COUNT(DISTINCT sender_name)").From("channel_messages").
		Where("channel_id = ? AND direction = 'inbound' AND created_at >= ?", channelID, today)).Scan(&stats.ActiveUsers)
	s.db.QueryRow(ctx, Select("COUNT(*)").From("channel_messages").
		Where("channel_id = ? AND status = 'failed' AND created_at >= ?", channelID, today)).Scan(&stats.FailedMessages)

	stats.HourlyTrend = make([]model.HourlyTrendItem, 24)
	for i := range stats.HourlyTrend {
		stats.HourlyTrend[i].Hour = i
	}
	return stats, nil
}

// Messages

func (s *ChannelStore) ListMessages(ctx context.Context, channelID string, page, pageSize int, filters map[string]string) ([]model.ChannelMessage, int, error) {
	if pageSize <= 0 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize
	if offset < 0 {
		offset = 0
	}

	q := Select("id", "channel_id", "direction", "sender_name", "content",
		"agent_id", "agent_name", "status", "error_detail", "processing_ms", "created_at").
		From("channel_messages").Where("channel_id = ?", channelID)

	countQ := Select("COUNT(*)").From("channel_messages").Where("channel_id = ?", channelID)

	if d, ok := filters["direction"]; ok && d != "" {
		q = q.Where("direction = ?", d)
		countQ = countQ.Where("direction = ?", d)
	}
	if st, ok := filters["status"]; ok && st != "" {
		q = q.Where("status = ?", st)
		countQ = countQ.Where("status = ?", st)
	}

	var total int
	s.db.QueryRow(ctx, countQ).Scan(&total)

	rows, err := s.db.Query(ctx, q.OrderBy("created_at DESC").Limit(uint64(pageSize)).Offset(uint64(offset)))
	if err != nil {
		return nil, 0, fmt.Errorf("list channel messages: %w", err)
	}
	defer rows.Close()

	var msgs []model.ChannelMessage
	for rows.Next() {
		var m model.ChannelMessage
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.Direction, &m.SenderName, &m.Content,
			&m.AgentID, &m.AgentName, &m.Status, &m.ErrorDetail, &m.ProcessingMs, &m.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan channel message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, total, nil
}

// Routing Rules

func (s *ChannelStore) ListRules(ctx context.Context, channelID string) ([]model.RoutingRule, error) {
	rows, err := s.db.Query(ctx,
		Select("id", "channel_id", "priority", "field", "operator", "value",
			"target_agent_id", "target_agent_name", "enabled").
			From("routing_rules").Where("channel_id = ?", channelID).OrderBy("priority"),
	)
	if err != nil {
		return nil, fmt.Errorf("list rules: %w", err)
	}
	defer rows.Close()
	var rules []model.RoutingRule
	for rows.Next() {
		var r model.RoutingRule
		if err := rows.Scan(&r.ID, &r.ChannelID, &r.Priority, &r.Field, &r.Operator, &r.Value,
			&r.TargetAgentID, &r.TargetAgentName, &r.Enabled); err != nil {
			return nil, fmt.Errorf("scan rule: %w", err)
		}
		rules = append(rules, r)
	}
	return rules, nil
}

func (s *ChannelStore) CreateRule(ctx context.Context, rule *model.RoutingRule) (*model.RoutingRule, error) {
	err := s.db.QueryRow(ctx,
		Insert("routing_rules").
			Columns("channel_id", "priority", "field", "operator", "value", "target_agent_id", "target_agent_name", "enabled").
			Values(rule.ChannelID, rule.Priority, rule.Field, rule.Operator, rule.Value, rule.TargetAgentID, rule.TargetAgentName, true).
			Suffix("RETURNING id"),
	).Scan(&rule.ID)
	if err != nil {
		return nil, fmt.Errorf("create rule: %w", err)
	}
	rule.Enabled = true
	return rule, nil
}

func (s *ChannelStore) UpdateRule(ctx context.Context, ruleID string, fields map[string]interface{}) (*model.RoutingRule, error) {
	b := SetFields(Update("routing_rules"), fields).
		Where("id = ?", ruleID).
		Suffix("RETURNING id, channel_id, priority, field, operator, value, target_agent_id, target_agent_name, enabled")
	r := &model.RoutingRule{}
	err := s.db.QueryRow(ctx, b).Scan(&r.ID, &r.ChannelID, &r.Priority, &r.Field, &r.Operator,
		&r.Value, &r.TargetAgentID, &r.TargetAgentName, &r.Enabled)
	if err != nil {
		return nil, fmt.Errorf("update rule: %w", err)
	}
	return r, nil
}

func (s *ChannelStore) DeleteRule(ctx context.Context, ruleID string) error {
	return s.db.Exec(ctx, Delete("routing_rules").Where("id = ?", ruleID))
}

func scanChannels(rows pgx.Rows) ([]model.Channel, error) {
	var channels []model.Channel
	for rows.Next() {
		var ch model.Channel
		var configJSON []byte
		if err := rows.Scan(&ch.ID, &ch.WorkspaceID, &ch.Type, &ch.Name, &ch.Status,
			&ch.ConnectedChannels, &ch.LastActiveAt, &ch.RealtimeConnected, &ch.ConnectionState,
			&ch.ConnectionMode, &ch.LastConnectedAt, &ch.ConnectionLastError, &ch.DefaultAgentID,
			&configJSON, &ch.CreatedAt, &ch.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan channel: %w", err)
		}
		json.Unmarshal(configJSON, &ch.Config)
		if ch.Config == nil {
			ch.Config = map[string]string{}
		}
		channels = append(channels, ch)
	}
	return channels, nil
}
