#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="$ROOT/proto"
GATEWAY_DIR="$ROOT/gateway"
SERVICE_OUT="$ROOT/service/src/generated"

mkdir -p "$SERVICE_OUT"

ALL_PROTOS="$PROTO_DIR/common.proto $PROTO_DIR/auth.proto $PROTO_DIR/org.proto $PROTO_DIR/workspace.proto $PROTO_DIR/settings.proto $PROTO_DIR/tools.proto $PROTO_DIR/channels.proto $PROTO_DIR/scheduler.proto $PROTO_DIR/agent_run.proto $PROTO_DIR/chat.proto"

echo "Generating Go protobuf code..."
protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$GATEWAY_DIR" \
  --go_opt=module=github.com/liukai/next-ai-agent-user-backend/gateway \
  --go-grpc_out="$GATEWAY_DIR" \
  --go-grpc_opt=module=github.com/liukai/next-ai-agent-user-backend/gateway \
  $ALL_PROTOS

echo "Generating TypeScript protobuf code..."
protoc \
  --proto_path="$PROTO_DIR" \
  --plugin="$ROOT/service/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$SERVICE_OUT" \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,stringEnums=true \
  $ALL_PROTOS

echo "Done."
