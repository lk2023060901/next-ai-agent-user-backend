#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="$ROOT/proto"
GATEWAY_DIR="$ROOT/gateway"
SERVICE_OUT="$ROOT/service/src/generated"

mkdir -p "$SERVICE_OUT"

echo "Generating Go protobuf code..."
protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$GATEWAY_DIR" \
  --go_opt=module=github.com/liukai/next-ai-agent-user-backend/gateway \
  --go-grpc_out="$GATEWAY_DIR" \
  --go-grpc_opt=module=github.com/liukai/next-ai-agent-user-backend/gateway \
  "$PROTO_DIR"/common.proto "$PROTO_DIR"/auth.proto

echo "Generating TypeScript protobuf code..."
protoc \
  --proto_path="$PROTO_DIR" \
  --plugin="$ROOT/service/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$SERVICE_OUT" \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,stringEnums=true \
  "$PROTO_DIR"/common.proto "$PROTO_DIR"/auth.proto

echo "Done."
