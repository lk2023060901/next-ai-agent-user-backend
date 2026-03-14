package store

import (
	"context"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

type SessionStore struct {
	db *DB
}

func NewSessionStore(db *DB) *SessionStore {
	return &SessionStore{db: db}
}

var sessionColumns = []string{
	"id", "workspace_id", "title", "status", "message_count",
	"is_pinned", "pinned_at", "last_message_at", "created_at",
}

func (s *SessionStore) List(ctx context.Context, workspaceID string) ([]model.Session, error) {
	rows, err := s.db.Query(ctx,
		Select(sessionColumns...).From("sessions").
			Where("workspace_id = ?", workspaceID).
			OrderBy("is_pinned DESC", "COALESCE(pinned_at, created_at) DESC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	return scanSessions(rows)
}

func (s *SessionStore) Create(ctx context.Context, workspaceID, title string) (*model.Session, error) {
	sess := &model.Session{}
	err := s.db.QueryRow(ctx,
		Insert("sessions").
			Columns("workspace_id", "title").
			Values(workspaceID, title).
			Suffix("RETURNING "+JoinCols(sessionColumns)),
	).Scan(&sess.ID, &sess.WorkspaceID, &sess.Title, &sess.Status, &sess.MessageCount,
		&sess.IsPinned, &sess.PinnedAt, &sess.LastMessageAt, &sess.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}
	return sess, nil
}

func (s *SessionStore) GetByID(ctx context.Context, id string) (*model.Session, error) {
	sess := &model.Session{}
	err := s.db.QueryRow(ctx,
		Select(sessionColumns...).From("sessions").Where("id = ?", id),
	).Scan(&sess.ID, &sess.WorkspaceID, &sess.Title, &sess.Status, &sess.MessageCount,
		&sess.IsPinned, &sess.PinnedAt, &sess.LastMessageAt, &sess.CreatedAt)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get session: %w", err)
	}
	return sess, nil
}

func (s *SessionStore) Update(ctx context.Context, id string, fields map[string]interface{}) (*model.Session, error) {
	b := SetFields(Update("sessions"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", id).
		Suffix("RETURNING " + JoinCols(sessionColumns))

	sess := &model.Session{}
	err := s.db.QueryRow(ctx, b).Scan(
		&sess.ID, &sess.WorkspaceID, &sess.Title, &sess.Status, &sess.MessageCount,
		&sess.IsPinned, &sess.PinnedAt, &sess.LastMessageAt, &sess.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("update session: %w", err)
	}
	return sess, nil
}

func (s *SessionStore) Delete(ctx context.Context, id string) error {
	return s.db.Exec(ctx, Delete("sessions").Where("id = ?", id))
}

// --- Messages ---

var messageColumns = []string{"id", "session_id", "role", "content", "agent_id", "status", "created_at"}

func (s *SessionStore) ListMessages(ctx context.Context, sessionID string, limit int, beforeID *string) (*model.MessagePage, error) {
	if limit <= 0 {
		limit = 40
	}
	fetchLimit := limit + 1

	q := Select(messageColumns...).From("messages").
		Where("session_id = ?", sessionID).
		OrderBy("created_at DESC").
		Limit(uint64(fetchLimit))

	if beforeID != nil && *beforeID != "" {
		q = q.Where("created_at < (SELECT created_at FROM messages WHERE id = ?)", *beforeID)
	}

	rows, err := s.db.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()

	msgs, err := scanMessages(rows)
	if err != nil {
		return nil, err
	}

	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}

	// Reverse to chronological order
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	page := &model.MessagePage{Messages: msgs, HasMore: hasMore}
	if hasMore && len(msgs) > 0 {
		first := msgs[0].ID
		page.NextBeforeMessageID = &first
	}
	return page, nil
}

func (s *SessionStore) CreateMessage(ctx context.Context, sessionID, role, content string) (*model.Message, error) {
	m := &model.Message{}
	err := s.db.QueryRow(ctx,
		Insert("messages").
			Columns("session_id", "role", "content", "status").
			Values(sessionID, role, content, "sent").
			Suffix("RETURNING "+JoinCols(messageColumns)),
	).Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.AgentID, &m.Status, &m.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create message: %w", err)
	}

	// Update session counters
	now := time.Now()
	_ = s.db.Exec(ctx,
		Update("sessions").
			Set("message_count", sq.Expr("message_count + 1")).
			Set("last_message_at", now).
			Set("updated_at", now).
			Where("id = ?", sessionID),
	)
	return m, nil
}

func (s *SessionStore) UpdateMessage(ctx context.Context, sessionID, messageID, content string) (*model.Message, []string, error) {
	m := &model.Message{}
	err := s.db.QueryRow(ctx,
		Update("messages").
			Set("content", content).
			Where("id = ? AND session_id = ?", messageID, sessionID).
			Suffix("RETURNING "+JoinCols(messageColumns)),
	).Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.AgentID, &m.Status, &m.CreatedAt)
	if err != nil {
		return nil, nil, fmt.Errorf("update message: %w", err)
	}

	// Remove subsequent messages
	rows, err := s.db.Query(ctx,
		Delete("messages").
			Where("session_id = ? AND created_at > ?", sessionID, m.CreatedAt).
			Suffix("RETURNING id"),
	)
	if err != nil {
		return m, nil, nil
	}
	defer rows.Close()

	var removedIDs []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		removedIDs = append(removedIDs, id)
	}

	// Recount messages
	var count int
	s.db.QueryRow(ctx,
		Select("COUNT(*)").From("messages").Where("session_id = ?", sessionID),
	).Scan(&count)
	_ = s.db.Exec(ctx,
		Update("sessions").
			Set("message_count", count).
			Set("updated_at", sq.Expr("NOW()")).
			Where("id = ?", sessionID),
	)

	return m, removedIDs, nil
}

func scanSessions(rows pgx.Rows) ([]model.Session, error) {
	var sessions []model.Session
	for rows.Next() {
		var sess model.Session
		if err := rows.Scan(&sess.ID, &sess.WorkspaceID, &sess.Title, &sess.Status,
			&sess.MessageCount, &sess.IsPinned, &sess.PinnedAt, &sess.LastMessageAt,
			&sess.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		sessions = append(sessions, sess)
	}
	return sessions, nil
}

func scanMessages(rows pgx.Rows) ([]model.Message, error) {
	var msgs []model.Message
	for rows.Next() {
		var m model.Message
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.AgentID, &m.Status, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, nil
}
