# ==============================================================================
# STAGE 1: BUILDER
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy root monorepo workspaces declarations and locks
COPY package*.json ./

# Copy package configurations of all workspace projects to resolve dependencies
COPY shared/logger/package*.json ./shared/logger/
COPY shared/kafka/package*.json ./shared/kafka/
COPY shared/redis/package*.json ./shared/redis/
COPY shared/schemas/package*.json ./shared/schemas/
COPY services/push-worker/package*.json ./services/push-worker/

# Install only production dependencies across all workspaces cleanly
RUN npm ci --omit=dev

# Copy active source files
COPY shared/logger/ ./shared/logger/
COPY shared/kafka/ ./shared/kafka/
COPY shared/redis/ ./shared/redis/
COPY shared/schemas/ ./shared/schemas/
COPY services/push-worker/ ./services/push-worker/

# ==============================================================================
# STAGE 2: RUNNER
# ==============================================================================
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Copy pre-bootstrapped node_modules and built sources from Builder stage
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/shared ./shared
COPY --from=builder /usr/src/app/services/push-worker ./services/push-worker

# Run as non-root user for security container hardening
USER node

CMD ["node", "services/push-worker/index.js"]
