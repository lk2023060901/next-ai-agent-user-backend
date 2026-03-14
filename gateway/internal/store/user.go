package store

import (
	"context"
	"fmt"

	"github.com/nextai-agent/gateway/internal/model"
)

type UserStore struct {
	db *DB
}

func NewUserStore(db *DB) *UserStore {
	return &UserStore{db: db}
}

var userColumns = []string{"id", "name", "email", "password_hash", "avatar_url", "created_at", "updated_at"}
var userPublicColumns = []string{"id", "name", "email", "avatar_url", "created_at", "updated_at"}

func (s *UserStore) Create(ctx context.Context, name, email, passwordHash string) (*model.User, error) {
	u := &model.User{}
	err := s.db.QueryRow(ctx,
		Insert("users").
			Columns("name", "email", "password_hash").
			Values(name, email, passwordHash).
			Suffix("RETURNING id, name, email, avatar_url, created_at, updated_at"),
	).Scan(&u.ID, &u.Name, &u.Email, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

func (s *UserStore) GetByEmail(ctx context.Context, email string) (*model.User, error) {
	u := &model.User{}
	err := s.db.QueryRow(ctx,
		Select(userColumns...).From("users").Where("email = ?", email),
	).Scan(&u.ID, &u.Name, &u.Email, &u.PasswordHash, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by email: %w", err)
	}
	return u, nil
}

func (s *UserStore) GetByID(ctx context.Context, id string) (*model.User, error) {
	u := &model.User{}
	err := s.db.QueryRow(ctx,
		Select(userPublicColumns...).From("users").Where("id = ?", id),
	).Scan(&u.ID, &u.Name, &u.Email, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by id: %w", err)
	}
	return u, nil
}
