# Build context: next-ai-agent-user-backend/ (parent dir)
# docker build -f service/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /app/service
COPY service/package*.json ./
RUN npm ci --ignore-scripts
COPY service/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY --from=builder /app/service/dist ./dist
COPY --from=builder /app/service/node_modules ./node_modules
COPY --from=builder /app/service/package.json ./
RUN npm rebuild better-sqlite3
COPY proto/ ./proto/
ENV NODE_ENV=production
EXPOSE 50051 3001
CMD ["node", "dist/server.js"]
