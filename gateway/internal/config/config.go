package config

import (
	"os"
)

type Config struct {
	Port           string
	GRPCAddr       string
	BifrostAddr    string
	RuntimeAddr    string
	JWTSecret      string
	RuntimeSecret  string
	AllowedOrigins []string
}

func Load() *Config {
	return &Config{
		Port:           getEnv("PORT", "8080"),
		GRPCAddr:       getEnv("GRPC_ADDR", "localhost:50051"),
		BifrostAddr:    getEnv("BIFROST_ADDR", "http://localhost:8081"),
		RuntimeAddr:    getEnv("RUNTIME_ADDR", "http://localhost:8082"),
		JWTSecret:      getEnv("JWT_SECRET", "dev-secret-change-in-production"),
		RuntimeSecret:  getEnv("RUNTIME_SECRET", "dev-runtime-secret"),
		AllowedOrigins: []string{"http://localhost:3000", "http://localhost:3001", "http://localhost:3002", getEnv("FRONTEND_URL", "")},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
