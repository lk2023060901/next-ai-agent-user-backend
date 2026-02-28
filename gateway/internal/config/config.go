package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Port               string
	GRPCAddr           string
	BifrostAddr        string
	RuntimeAddr        string
	JWTSecret          string
	RuntimeSecret      string
	WebSearchProvider  string
	WebSearchEndpoint  string
	WebSearchTimeoutMs int
	AllowedOrigins     []string
}

func Load() *Config {
	return &Config{
		Port:               getEnv("PORT", "8080"),
		GRPCAddr:           getEnv("GRPC_ADDR", "localhost:50051"),
		BifrostAddr:        getEnv("BIFROST_ADDR", "http://localhost:8081"),
		RuntimeAddr:        getEnv("RUNTIME_ADDR", "http://localhost:8082"),
		JWTSecret:          getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		RuntimeSecret:      getEnv("RUNTIME_SECRET", "dev-runtime-secret"),
		WebSearchProvider:  getEnv("WEB_SEARCH_PROVIDER", "duckduckgo"),
		WebSearchEndpoint:  getEnv("WEB_SEARCH_ENDPOINT", "https://api.duckduckgo.com/"),
		WebSearchTimeoutMs: getIntEnv("WEB_SEARCH_TIMEOUT_MS", 12000),
		AllowedOrigins:     buildAllowedOrigins(getEnv("FRONTEND_URL", "")),
	}
}

func buildAllowedOrigins(frontendURL string) []string {
	origins := []string{
		"http://localhost:3000",
		"http://localhost:3001",
		"http://localhost:3002",
		"http://127.0.0.1:3000",
		"http://127.0.0.1:3001",
		"http://127.0.0.1:3002",
		"http://[::1]:3000",
		"http://[::1]:3001",
		"http://[::1]:3002",
	}

	frontendURL = strings.TrimSpace(frontendURL)
	if frontendURL != "" {
		origins = append(origins, frontendURL)
	}

	return origins
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getIntEnv(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	v := strings.TrimSpace(raw)
	if v == "" {
		return fallback
	}
	var out int
	_, err := fmt.Sscanf(v, "%d", &out)
	if err != nil || out <= 0 {
		return fallback
	}
	return out
}
