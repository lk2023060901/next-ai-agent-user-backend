# Build context: next-ai-agent-user-backend/ (parent dir)
# docker build -f runtime/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /app/runtime
COPY runtime/package*.json ./
RUN npm ci --ignore-scripts
COPY runtime/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY --from=builder /app/runtime/dist ./dist
COPY --from=builder /app/runtime/node_modules ./node_modules
COPY --from=builder /app/runtime/package.json ./
RUN npm rebuild better-sqlite3
COPY proto/ ./proto/
ENV NODE_ENV=production
# In Docker, bind to 0.0.0.0 since container networking handles isolation
ENV RUNTIME_HOST=0.0.0.0
EXPOSE 8082
CMD ["node", "dist/main.js"]
