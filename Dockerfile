# Matching Engine and DB Writer
# One image, two run modes:
#   - Matching engine (default): docker run --env-file .env <image>
#   - DB writer: docker run --env-file .env <image> node dist/services/db-writer-main.js
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

RUN pnpm install --frozen-lockfile --prod

# Default: run matching engine. Override with: node dist/services/db-writer-main.js
CMD ["node", "dist/services/main.js"]
