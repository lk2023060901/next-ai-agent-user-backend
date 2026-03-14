package service

import "errors"

var (
	ErrUserExists          = errors.New("USER_ALREADY_EXISTS")
	ErrInvalidCredentials  = errors.New("INVALID_CREDENTIALS")
	ErrInvalidRefreshToken = errors.New("INVALID_REFRESH_TOKEN")
	ErrInvalidAccessToken  = errors.New("INVALID_ACCESS_TOKEN")
)
