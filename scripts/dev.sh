#!/usr/bin/env bash
# Start all services for development
# Usage: bash scripts/dev.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Starting TypeScript service on :50051 (gRPC)..."
cd "$ROOT/service" && npm run dev &
TS_PID=$!

sleep 2

echo "Starting Go gateway on :8080..."
cd "$ROOT/gateway" && go run cmd/gateway/main.go &
GO_PID=$!

sleep 1

echo "Starting Runtime on :8082..."
cd "$ROOT/runtime" && npm run dev &
RUNTIME_PID=$!

trap "kill $TS_PID $GO_PID $RUNTIME_PID 2>/dev/null" EXIT INT TERM
wait
