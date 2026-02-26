.PHONY: proto dev-gateway dev-service dev-runtime setup build-gateway build-service build-runtime

proto:
	bash scripts/gen-proto.sh

setup:
	cd gateway && go mod download
	cd service && npm install
	cd runtime && npm install

dev-gateway:
	cd gateway && go run cmd/gateway/main.go

dev-service:
	cd service && npm run dev

dev-runtime:
	cd runtime && npm run dev

build-gateway:
	cd gateway && go build -o bin/gateway cmd/gateway/main.go

build-service:
	cd service && npm run build

build-runtime:
	cd runtime && npm run build
