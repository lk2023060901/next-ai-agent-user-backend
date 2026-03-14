package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const (
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 7 * 24 * time.Hour
)

type AuthTokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"`
}

type AuthService struct {
	users  *store.UserStore
	orgs   *store.OrgStore
	tokens *store.TokenStore
	secret []byte
}

func NewAuthService(users *store.UserStore, orgs *store.OrgStore, tokens *store.TokenStore, jwtSecret string) *AuthService {
	return &AuthService{
		users:  users,
		orgs:   orgs,
		tokens: tokens,
		secret: []byte(jwtSecret),
	}
}

func (s *AuthService) Signup(ctx context.Context, name, email, password string) (*model.User, *AuthTokens, error) {
	existing, err := s.users.GetByEmail(ctx, email)
	if err != nil {
		return nil, nil, fmt.Errorf("check existing user: %w", err)
	}
	if existing != nil {
		return nil, nil, ErrUserExists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, nil, fmt.Errorf("hash password: %w", err)
	}

	user, err := s.users.Create(ctx, name, email, string(hash))
	if err != nil {
		return nil, nil, fmt.Errorf("create user: %w", err)
	}

	// Create default org and workspace for new user
	slug := strings.Split(email, "@")[0]
	org, err := s.orgs.Create(ctx, name+"'s Org", slug, "free")
	if err != nil {
		return nil, nil, fmt.Errorf("create default org: %w", err)
	}
	if err := s.orgs.AddMember(ctx, org.ID, user.ID, "owner"); err != nil {
		return nil, nil, fmt.Errorf("add org member: %w", err)
	}
	if _, err := s.orgs.CreateWorkspace(ctx, org.ID, "Default", "default", "🤖"); err != nil {
		return nil, nil, fmt.Errorf("create default workspace: %w", err)
	}

	tokens, err := s.issueTokens(ctx, user.ID)
	if err != nil {
		return nil, nil, err
	}

	return user, tokens, nil
}

func (s *AuthService) Login(ctx context.Context, email, password string) (*model.User, *AuthTokens, error) {
	user, err := s.users.GetByEmail(ctx, email)
	if err != nil {
		return nil, nil, fmt.Errorf("find user: %w", err)
	}
	if user == nil {
		return nil, nil, ErrInvalidCredentials
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, nil, ErrInvalidCredentials
	}

	tokens, err := s.issueTokens(ctx, user.ID)
	if err != nil {
		return nil, nil, err
	}

	return user, tokens, nil
}

func (s *AuthService) Refresh(ctx context.Context, refreshToken string) (*AuthTokens, error) {
	userID, err := s.tokens.ValidateRefreshToken(ctx, refreshToken)
	if err != nil {
		return nil, fmt.Errorf("validate refresh token: %w", err)
	}
	if userID == "" {
		return nil, ErrInvalidRefreshToken
	}

	// Rotate: delete old, issue new
	_ = s.tokens.DeleteRefreshToken(ctx, refreshToken)

	tokens, err := s.issueTokens(ctx, userID)
	if err != nil {
		return nil, err
	}
	return tokens, nil
}

func (s *AuthService) GetUser(ctx context.Context, userID string) (*model.User, error) {
	return s.users.GetByID(ctx, userID)
}

func (s *AuthService) ValidateAccessToken(tokenStr string) (string, error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.secret, nil
	})
	if err != nil {
		return "", ErrInvalidAccessToken
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return "", ErrInvalidAccessToken
	}

	sub, _ := claims.GetSubject()
	if sub == "" {
		return "", ErrInvalidAccessToken
	}
	return sub, nil
}

func (s *AuthService) issueTokens(ctx context.Context, userID string) (*AuthTokens, error) {
	now := time.Now()

	accessClaims := jwt.MapClaims{
		"sub": userID,
		"iat": now.Unix(),
		"exp": now.Add(accessTokenTTL).Unix(),
	}
	accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessStr, err := accessToken.SignedString(s.secret)
	if err != nil {
		return nil, fmt.Errorf("sign access token: %w", err)
	}

	refreshStr := uuid.NewString()
	expiresAt := now.Add(refreshTokenTTL)
	if err := s.tokens.SaveRefreshToken(ctx, userID, refreshStr, expiresAt); err != nil {
		return nil, fmt.Errorf("save refresh token: %w", err)
	}

	return &AuthTokens{
		AccessToken:  accessStr,
		RefreshToken: refreshStr,
		ExpiresIn:    int(accessTokenTTL.Seconds()),
	}, nil
}
