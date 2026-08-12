# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --prefer-offline --no-audit --no-fund

COPY . .

# Run database migrations at build time to bundle the schema
RUN mkdir -p data

RUN npm run build
RUN MC_WORKER_RUNTIME_SOURCE=.next/standalone node scripts/smoke-sync-worker-runtime.mjs

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ARG MC_BUILD_SHA
ARG MC_DEPLOYMENT_REVISION
LABEL org.opencontainers.image.revision=$MC_BUILD_SHA \
      org.opencontainers.image.version=$MC_DEPLOYMENT_REVISION

# better-sqlite3 needs libc++ at runtime
RUN apk add --no-cache libc6-compat \
    && addgroup -S mc && adduser -S mc -G mc

# Copy standalone server output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts/sync-worker-healthcheck.mjs ./scripts/sync-worker-healthcheck.mjs

# Copy Drizzle migrations for runtime migration support
COPY --from=builder /app/drizzle ./drizzle

# Data volume for SQLite persistence
RUN mkdir -p /app/data && chown -R mc:mc /app/data
VOLUME /app/data

USER mc

ENV NODE_ENV=production
ENV PORT=3099
ENV HOSTNAME=0.0.0.0
ENV MC_DB_PATH=/app/data/mission-control.db
ENV MC_BUILD_SHA=$MC_BUILD_SHA
ENV MC_DEPLOYMENT_REVISION=$MC_DEPLOYMENT_REVISION
ENV NODE_OPTIONS=--max-old-space-size=512

EXPOSE 3099

CMD ["node", "server.js"]
