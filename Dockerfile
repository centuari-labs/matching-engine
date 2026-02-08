# Matching Engine and DB Writer
# One image, run modes:
#   - Both (default): docker run --env-file .env <image>
#   - Matching engine only: docker run --env-file .env <image> node dist/services/main.js
#   - DB writer only: docker run --env-file .env <image> node dist/services/db-writer-main.js
# Requires NATS, Redis, and Postgres; set NATS_URL, REDIS_URL, DB_URL and related env (see env.example).

# -----------------------------------------------------------------------------
# Builder stage
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src

RUN pnpm install --frozen-lockfile && pnpm run build

# -----------------------------------------------------------------------------
# Runtime stage
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Enable pnpm for install
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./

RUN pnpm install --frozen-lockfile --prod && chmod +x docker-entrypoint.sh

# Default: run both matching engine and DB writer. Override CMD to run one:
#   node dist/services/main.js
#   node dist/services/db-writer-main.js
CMD ["./docker-entrypoint.sh"]
