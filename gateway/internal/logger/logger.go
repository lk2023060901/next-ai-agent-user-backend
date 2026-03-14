package logger

import (
	"os"
	"sync"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/lumberjack.v2"
)

var (
	instance *zap.Logger
	once     sync.Once
)

// Options configures the logger.
type Options struct {
	File       string // log file path; empty = stdout only
	MaxSizeMB  int    // max file size in MB before rotation (default 100)
	MaxBackups int    // max rotated files to keep (default 5)
	MaxAgeDays int    // max days to keep rotated files (default 30)
}

// Init initializes the global logger.
func Init(env string, opts ...Options) {
	once.Do(func() {
		var opt Options
		if len(opts) > 0 {
			opt = opts[0]
		}
		if opt.MaxSizeMB <= 0 {
			opt.MaxSizeMB = 100
		}
		if opt.MaxBackups <= 0 {
			opt.MaxBackups = 5
		}
		if opt.MaxAgeDays <= 0 {
			opt.MaxAgeDays = 30
		}

		// Encoder
		var encCfg zapcore.EncoderConfig
		var encoder zapcore.Encoder
		if env == "production" {
			encCfg = zap.NewProductionEncoderConfig()
			encCfg.TimeKey = "ts"
			encCfg.EncodeTime = zapcore.ISO8601TimeEncoder
			encoder = zapcore.NewJSONEncoder(encCfg)
		} else {
			encCfg = zap.NewDevelopmentEncoderConfig()
			encCfg.EncodeLevel = zapcore.CapitalColorLevelEncoder
			encoder = zapcore.NewConsoleEncoder(encCfg)
		}

		// Cores
		var cores []zapcore.Core
		cores = append(cores, zapcore.NewCore(encoder, zapcore.AddSync(os.Stdout), level(env)))

		if opt.File != "" {
			fileEncCfg := zap.NewProductionEncoderConfig()
			fileEncCfg.TimeKey = "ts"
			fileEncCfg.EncodeTime = zapcore.ISO8601TimeEncoder
			fileCore := zapcore.NewCore(
				zapcore.NewJSONEncoder(fileEncCfg),
				zapcore.AddSync(&lumberjack.Logger{
					Filename:   opt.File,
					MaxSize:    opt.MaxSizeMB,
					MaxBackups: opt.MaxBackups,
					MaxAge:     opt.MaxAgeDays,
					LocalTime:  true,
				}),
				level(env),
			)
			cores = append(cores, fileCore)
		}

		instance = zap.New(zapcore.NewTee(cores...), zap.AddCaller(), zap.AddCallerSkip(1))
	})
}

func level(env string) zapcore.Level {
	if env == "production" {
		return zapcore.InfoLevel
	}
	return zapcore.DebugLevel
}

// L returns the global *zap.Logger.
func L() *zap.Logger {
	if instance == nil {
		Init(os.Getenv("ENV"))
	}
	return instance
}

// Named returns a named child logger.
func Named(name string) *zap.Logger {
	return L().Named(name)
}

// Structured logging with zap.Field — type-safe, no key-value pair mismatch risk.

func Debug(msg string, fields ...zap.Field) { L().Debug(msg, fields...) }
func Info(msg string, fields ...zap.Field)  { L().Info(msg, fields...) }
func Warn(msg string, fields ...zap.Field)  { L().Warn(msg, fields...) }
func Error(msg string, fields ...zap.Field) { L().Error(msg, fields...) }
func Fatal(msg string, fields ...zap.Field) { L().Fatal(msg, fields...) }

// Sync flushes any buffered log entries. Call before process exit.
func Sync() {
	if instance != nil {
		_ = instance.Sync()
	}
}
