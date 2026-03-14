package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

type TokenStore struct {
	db *DB
}

func NewTokenStore(db *DB) *TokenStore {
	return &TokenStore{db: db}
}

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

func (s *TokenStore) SaveRefreshToken(ctx context.Context, userID, rawToken string, expiresAt time.Time) error {
	return s.db.Exec(ctx,
		Insert("refresh_tokens").
			Columns("user_id", "token_hash", "expires_at").
			Values(userID, hashToken(rawToken), expiresAt),
	)
}

func (s *TokenStore) ValidateRefreshToken(ctx context.Context, rawToken string) (string, error) {
	var userID string
	err := s.db.QueryRow(ctx,
		Select("user_id").From("refresh_tokens").
			Where("token_hash = ? AND expires_at > NOW()", hashToken(rawToken)),
	).Scan(&userID)
	if err != nil {
		if IsNotFound(err) {
			return "", nil
		}
		return "", fmt.Errorf("validate refresh token: %w", err)
	}
	return userID, nil
}

func (s *TokenStore) DeleteRefreshToken(ctx context.Context, rawToken string) error {
	return s.db.Exec(ctx,
		Delete("refresh_tokens").Where("token_hash = ?", hashToken(rawToken)),
	)
}

func (s *TokenStore) DeleteUserTokens(ctx context.Context, userID string) error {
	return s.db.Exec(ctx,
		Delete("refresh_tokens").Where("user_id = ?", userID),
	)
}
