package middleware

import (
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

type MapClaims = jwt.MapClaims

func TestSecureCompare(t *testing.T) {
	tests := []struct {
		name string
		a, b string
		want bool
	}{
		{"equal strings", "secret123", "secret123", true},
		{"different strings", "secret123", "secret456", false},
		{"empty strings", "", "", true},
		{"one empty", "secret", "", false},
		{"different lengths", "short", "longer-string", false},
		{"same prefix", "abc123", "abc456", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := secureCompare(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("secureCompare(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestExtractUserClaims(t *testing.T) {
	t.Run("valid claims", func(t *testing.T) {
		claims := MapClaims{
			"user_id": "user-123",
			"email":   "test@example.com",
			"name":    "Test User",
		}
		user, ok := extractUserClaims(&claims)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		if user.UserID != "user-123" {
			t.Errorf("UserID = %q, want %q", user.UserID, "user-123")
		}
		if user.Email != "test@example.com" {
			t.Errorf("Email = %q, want %q", user.Email, "test@example.com")
		}
	})

	t.Run("missing user_id", func(t *testing.T) {
		claims := MapClaims{
			"email": "test@example.com",
		}
		_, ok := extractUserClaims(&claims)
		if ok {
			t.Fatal("expected ok to be false for missing user_id")
		}
	})

	t.Run("empty user_id", func(t *testing.T) {
		claims := MapClaims{
			"user_id": "",
		}
		_, ok := extractUserClaims(&claims)
		if ok {
			t.Fatal("expected ok to be false for empty user_id")
		}
	})

	t.Run("missing optional fields", func(t *testing.T) {
		claims := MapClaims{
			"user_id": "user-123",
		}
		user, ok := extractUserClaims(&claims)
		if !ok {
			t.Fatal("expected ok to be true")
		}
		if user.Email != "" {
			t.Errorf("Email = %q, want empty", user.Email)
		}
		if user.Name != "" {
			t.Errorf("Name = %q, want empty", user.Name)
		}
	})
}
