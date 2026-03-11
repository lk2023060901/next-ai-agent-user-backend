# Build context: next-ai-agent-user-backend/ (parent dir)
# docker build -f gateway/Dockerfile .
FROM golang:1.26-alpine AS builder
WORKDIR /app/gateway
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/ .
RUN CGO_ENABLED=0 go build -o /gateway cmd/gateway/main.go

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /gateway /gateway
ENV GO_ENV=production
EXPOSE 8080
CMD ["/gateway"]
