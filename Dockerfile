# Multi-stage Dockerfile supporting both Bun and Node.js
# Build with: docker build -t zerotrust:latest .
# Build with Node runtime: docker build -t zerotrust:node --build-arg RUNTIME=node .

ARG BUN_VERSION=1.4.0
ARG NODE_VERSION=20-alpine
ARG RUNTIME=bun

# ─── Stage 1: Builder ────────────────────────────────────────────────────────

FROM oven/bun:${BUN_VERSION} AS builder

WORKDIR /app

# bun.lock (text lockfile) + workspace manifests are required for a frozen
# install; scripts/postinstall.js runs as the root postinstall hook.
COPY package.json bun.lock ./
COPY packages/client/package.json ./packages/client/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/ui/package.json ./packages/ui/
# Bun resolves the shared workspace's exported TypeScript entry while linking
# workspaces, so its source must exist during the frozen install.
COPY packages/shared-types/src ./packages/shared-types/src/
COPY scripts/postinstall.js ./scripts/

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

# ─── Stage 2: Runtime (Bun) ───────────────────────────────────────────────────

FROM oven/bun:${BUN_VERSION} AS runtime-bun

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# node_modules/@zerotrust/shared-types links to ../../packages/shared-types
COPY --from=builder /app/packages/shared-types ./packages/shared-types
COPY package.json ./

# oven/bun already ships a non-root `bun` user (UID 1000); creating another
# UID-1000 user fails with useradd exit code 4
RUN chown -R bun:bun /app
USER bun

ENV NODE_ENV=production
ENV LOG_FORMAT=json
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "dist/src/api/server.js"]

# ─── Stage 3: Runtime (Node) ──────────────────────────────────────────────────

FROM node:${NODE_VERSION} AS runtime-node

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# node_modules/@zerotrust/shared-types links to ../../packages/shared-types
COPY --from=builder /app/packages/shared-types ./packages/shared-types
COPY package.json ./

# node:alpine already ships a non-root `node` user (UID 1000)
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV LOG_FORMAT=json
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/src/api/server.js"]

# ─── Final stage (select via --build-arg RUNTIME=bun|node) ─────────────────────

FROM runtime-${RUNTIME} AS runtime
