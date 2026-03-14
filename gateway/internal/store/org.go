package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/nextai-agent/gateway/internal/model"
)

type OrgStore struct {
	db *DB
}

func NewOrgStore(db *DB) *OrgStore {
	return &OrgStore{db: db}
}

var orgColumns = []string{"id", "name", "slug", "avatar_url", "plan", "created_at"}

func (s *OrgStore) Create(ctx context.Context, name, slug, plan string) (*model.Org, error) {
	o := &model.Org{}
	err := s.db.QueryRow(ctx,
		Insert("organizations").
			Columns("name", "slug", "plan").
			Values(name, slug, plan).
			Suffix("RETURNING "+JoinCols(orgColumns)),
	).Scan(&o.ID, &o.Name, &o.Slug, &o.AvatarURL, &o.Plan, &o.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create org: %w", err)
	}
	return o, nil
}

func (s *OrgStore) GetByID(ctx context.Context, id string) (*model.Org, error) {
	o := &model.Org{}
	err := s.db.QueryRow(ctx,
		Select(orgColumns...).From("organizations").Where("id = ?", id),
	).Scan(&o.ID, &o.Name, &o.Slug, &o.AvatarURL, &o.Plan, &o.CreatedAt)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get org: %w", err)
	}
	return o, nil
}

func (s *OrgStore) Update(ctx context.Context, id string, fields map[string]interface{}) (*model.Org, error) {
	b := SetFields(Update("organizations"), fields).
		Set("updated_at", "NOW()").
		Where("id = ?", id).
		Suffix("RETURNING " + JoinCols(orgColumns))
	o := &model.Org{}
	err := s.db.QueryRow(ctx, b).Scan(&o.ID, &o.Name, &o.Slug, &o.AvatarURL, &o.Plan, &o.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("update org: %w", err)
	}
	return o, nil
}

func (s *OrgStore) AddMember(ctx context.Context, orgID, userID, role string) error {
	return s.db.Exec(ctx,
		Insert("org_members").Columns("org_id", "user_id", "role").Values(orgID, userID, role),
	)
}

func (s *OrgStore) ListMembers(ctx context.Context, orgID string) ([]model.OrgMember, error) {
	rows, err := s.db.Query(ctx,
		Select("m.id", "m.user_id", "m.org_id", "m.role", "m.joined_at",
			"u.id", "u.name", "u.email", "u.avatar_url", "u.created_at", "u.updated_at").
			From("org_members m").
			Join("users u ON u.id = m.user_id").
			Where("m.org_id = ?", orgID).
			OrderBy("m.joined_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}
	defer rows.Close()

	var members []model.OrgMember
	for rows.Next() {
		var m model.OrgMember
		if err := rows.Scan(&m.ID, &m.UserID, &m.OrgID, &m.Role, &m.JoinedAt,
			&m.User.ID, &m.User.Name, &m.User.Email, &m.User.AvatarURL,
			&m.User.CreatedAt, &m.User.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan member: %w", err)
		}
		members = append(members, m)
	}
	return members, nil
}

func (s *OrgStore) ListByUser(ctx context.Context, userID string) ([]model.Org, error) {
	rows, err := s.db.Query(ctx,
		Select("o.id", "o.name", "o.slug", "o.avatar_url", "o.plan", "o.created_at").
			From("organizations o").
			Join("org_members m ON m.org_id = o.id").
			Where("m.user_id = ?", userID).
			OrderBy("o.created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list orgs: %w", err)
	}
	defer rows.Close()

	var orgs []model.Org
	for rows.Next() {
		var o model.Org
		if err := rows.Scan(&o.ID, &o.Name, &o.Slug, &o.AvatarURL, &o.Plan, &o.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan org: %w", err)
		}
		orgs = append(orgs, o)
	}
	return orgs, nil
}

func (s *OrgStore) CreateWorkspace(ctx context.Context, orgID, name, slug, emoji string) (*model.Workspace, error) {
	ws := &model.Workspace{}
	workspaceID := uuid.NewString()
	issuePrefix := "WS" + strings.ToUpper(strings.ReplaceAll(workspaceID, "-", "")[:6])
	err := s.db.QueryRow(ctx,
		Insert("workspaces").
			Columns("id", "org_id", "name", "slug", "emoji", "issue_prefix").
			Values(workspaceID, orgID, name, slug, emoji, issuePrefix).
			Suffix("RETURNING id, org_id, name, slug, emoji, description, created_at"),
	).Scan(&ws.ID, &ws.OrgID, &ws.Name, &ws.Slug, &ws.Emoji, &ws.Description, &ws.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create workspace: %w", err)
	}
	return ws, nil
}

func (s *OrgStore) ListWorkspaces(ctx context.Context, orgID string) ([]model.Workspace, error) {
	rows, err := s.db.Query(ctx,
		Select("id", "org_id", "name", "slug", "emoji", "description", "created_at").
			From("workspaces").
			Where("org_id = ?", orgID).
			OrderBy("created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	defer rows.Close()

	var wss []model.Workspace
	for rows.Next() {
		var ws model.Workspace
		if err := rows.Scan(&ws.ID, &ws.OrgID, &ws.Name, &ws.Slug, &ws.Emoji, &ws.Description, &ws.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		wss = append(wss, ws)
	}
	return wss, nil
}

// JoinCols joins column names with commas for RETURNING clause.
func JoinCols(cols []string) string {
	result := ""
	for i, c := range cols {
		if i > 0 {
			result += ", "
		}
		result += c
	}
	return result
}
