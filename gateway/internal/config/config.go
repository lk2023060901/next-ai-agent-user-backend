package config

import (
	"os"
)

type Config struct {
	Port           string
	GRPCAddr       string
	BifrostAddr    string
	JWTSecret      string
	AllowedOrigins []string
}

func Load() *Config {
	return &Config{
		Port:           getEnv("PORT", "8080"),
		GRPCAddr:       getEnv("GRPC_ADDR", "localhost:50051"),
		BifrostAddr:    getEnv("BIFROST_ADDR", "http://localhost:8081"),
		JWTSecret:      getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		AllowedOrigins: []string{"http://localhost:3000", getEnv("FRONTEND_URL", "")},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
