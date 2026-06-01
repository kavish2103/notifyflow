# ==============================================================================
# STAGE 1: BUILDER
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy root monorepo workspaces declarations and locks
COPY package*.json ./

# Copy package configurations of all workspace projects to resolve dependencies
COPY shared/logger/package*.json ./shared/logger/
COPY shared/redis/package*.json ./shared/redis/
COPY shared/schemas/package*.json ./shared/schemas/
COPY services/preference-template/package*.json ./services/preference-template/

# Install only production dependencies across all workspaces cleanly
RUN npm ci --omit=dev

# Copy active source files
COPY shared/logger/ ./shared/logger/
COPY shared/redis/ ./shared/redis/
COPY shared/schemas/ ./shared/schemas/
COPY services/preference-template/ ./services/preference-template/

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
COPY --from=builder /usr/src/app/services/preference-template ./services/preference-template

# Run as non-root user for security container hardening
USER node

EXPOSE 3003

CMD ["node", "services/preference-template/index.js"]
