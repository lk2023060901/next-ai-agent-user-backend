package store

import (
	"context"
	"errors"
	"fmt"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// psql is a squirrel statement builder configured for PostgreSQL ($1, $2, ...).
var psql = sq.StatementBuilder.PlaceholderFormat(sq.Dollar)

// DB wraps pgxpool.Pool with squirrel helpers for common CRUD operations.
type DB struct {
	Pool *pgxpool.Pool
}

// NewDB creates a new DB wrapper.
func NewDB(pool *pgxpool.Pool) *DB {
	return &DB{Pool: pool}
}

// --- Query helpers ---

// QueryRow executes a squirrel query and returns a single row.
func (db *DB) QueryRow(ctx context.Context, builder sq.Sqlizer) pgx.Row {
	sql, args, err := builder.ToSql()
	if err != nil {
		return &errRow{err: fmt.Errorf("build sql: %w", err)}
	}
	return db.Pool.QueryRow(ctx, sql, args...)
}

// Query executes a squirrel query and returns rows.
func (db *DB) Query(ctx context.Context, builder sq.Sqlizer) (pgx.Rows, error) {
	sql, args, err := builder.ToSql()
	if err != nil {
		return nil, fmt.Errorf("build sql: %w", err)
	}
	return db.Pool.Query(ctx, sql, args...)
}

// Exec executes a squirrel statement (INSERT/UPDATE/DELETE without returning rows).
func (db *DB) Exec(ctx context.Context, builder sq.Sqlizer) error {
	sql, args, err := builder.ToSql()
	if err != nil {
		return fmt.Errorf("build sql: %w", err)
	}
	_, err = db.Pool.Exec(ctx, sql, args...)
	return err
}

// --- Builder shortcuts ---

// Select starts a SELECT builder.
func Select(columns ...string) sq.SelectBuilder {
	return psql.Select(columns...)
}

// Insert starts an INSERT builder.
func Insert(table string) sq.InsertBuilder {
	return psql.Insert(table)
}

// Update starts an UPDATE builder.
func Update(table string) sq.UpdateBuilder {
	return psql.Update(table)
}

// Delete starts a DELETE builder.
func Delete(table string) sq.DeleteBuilder {
	return psql.Delete(table)
}

// --- Dynamic update helper ---

// SetFields applies a map of column->value to an UPDATE builder.
// Useful for PATCH endpoints where only provided fields are updated.
func SetFields(b sq.UpdateBuilder, fields map[string]interface{}) sq.UpdateBuilder {
	for col, val := range fields {
		b = b.Set(col, val)
	}
	return b
}

// --- Error helpers ---

// IsNotFound checks if the error is pgx.ErrNoRows.
func IsNotFound(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// errRow implements pgx.Row for returning errors from QueryRow.
type errRow struct {
	err error
}

func (r *errRow) Scan(_ ...interface{}) error {
	return r.err
}
