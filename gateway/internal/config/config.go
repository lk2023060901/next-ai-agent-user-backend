package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port                  string
	Env                   string
	DatabaseURL           string
	JWTSecret             string
	RuntimeBaseURL        string
	WorkflowOutputStorage WorkflowOutputStorageConfig
	Log                   LogConfig
}

type LogConfig struct {
	File       string // log file path, empty = stdout only
	MaxSizeMB  int    // max size per file in MB before rotation
	MaxBackups int    // max number of old log files to keep
	MaxAgeDays int    // max days to retain old log files
}

type WorkflowOutputStorageConfig struct {
	Endpoint         string
	AccessKey        string
	SecretKey        string
	Bucket           string
	Region           string
	UseSSL           bool
	AutoCreateBucket bool
}

func Load() *Config {
	return &Config{
		Port:           getEnv("PORT", "3001"),
		Env:            getEnv("ENV", "development"),
		DatabaseURL:    getEnv("DATABASE_URL", "postgres://nextai:nextai@localhost:5432/nextai?sslmode=disable"),
		JWTSecret:      getEnv("JWT_SECRET", "dev-jwt-secret-change-in-production"),
		RuntimeBaseURL: getEnv("RUNTIME_BASE_URL", "http://127.0.0.1:3002"),
		WorkflowOutputStorage: WorkflowOutputStorageConfig{
			Endpoint:         getEnv("WORKFLOW_OUTPUT_STORAGE_ENDPOINT", ""),
			AccessKey:        getEnv("WORKFLOW_OUTPUT_STORAGE_ACCESS_KEY", ""),
			SecretKey:        getEnv("WORKFLOW_OUTPUT_STORAGE_SECRET_KEY", ""),
			Bucket:           getEnv("WORKFLOW_OUTPUT_STORAGE_BUCKET", ""),
			Region:           getEnv("WORKFLOW_OUTPUT_STORAGE_REGION", "us-east-1"),
			UseSSL:           getEnvBool("WORKFLOW_OUTPUT_STORAGE_USE_SSL", false),
			AutoCreateBucket: getEnvBool("WORKFLOW_OUTPUT_STORAGE_AUTO_CREATE_BUCKET", true),
		},
		Log: LogConfig{
			File:       getEnv("LOG_FILE", ""),
			MaxSizeMB:  getEnvInt("LOG_MAX_SIZE_MB", 100),
			MaxBackups: getEnvInt("LOG_MAX_BACKUPS", 5),
			MaxAgeDays: getEnvInt("LOG_MAX_AGE_DAYS", 30),
		},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func getEnvBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		parsed, err := strconv.ParseBool(v)
		if err == nil {
			return parsed
		}
	}
	return fallback
}
