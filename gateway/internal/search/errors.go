package search

import (
	"context"
	"errors"
	"strings"
)

const (
	ErrorTypeConfig      = "config"
	ErrorTypeNetwork     = "network"
	ErrorTypeTimeout     = "timeout"
	ErrorTypeRateLimit   = "rate_limit"
	ErrorTypeUpstream5xx = "upstream_5xx"
	ErrorTypeUnknown     = "unknown"
)

type TypedError struct {
	Type string
	Err  error
}

func (e *TypedError) Error() string {
	if e == nil {
		return "unknown error"
	}
	if e.Err == nil {
		return e.Type
	}
	return e.Err.Error()
}

func (e *TypedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func NewTypedError(errorType string, err error) error {
	if err == nil {
		return &TypedError{Type: errorType, Err: errors.New(errorType)}
	}
	return &TypedError{Type: errorType, Err: err}
}

func ClassifyError(err error) string {
	if err == nil {
		return ""
	}
	var typed *TypedError
	if errors.As(err, &typed) && strings.TrimSpace(typed.Type) != "" {
		return typed.Type
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	if strings.Contains(msg, "timeout") || errors.Is(err, context.DeadlineExceeded) {
		return ErrorTypeTimeout
	}
	if strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "network is unreachable") ||
		strings.Contains(msg, "i/o timeout") {
		return ErrorTypeNetwork
	}
	if strings.Contains(msg, "429") {
		return ErrorTypeRateLimit
	}
	if strings.Contains(msg, "http 5") {
		return ErrorTypeUpstream5xx
	}
	return ErrorTypeUnknown
}
