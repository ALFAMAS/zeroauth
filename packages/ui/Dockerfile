# Multi-stage Next.js UI image (monorepo workspace build)
# Build: docker build -f packages/ui/Dockerfile -t zerotrust-ui:latest .
# Run:   docker run -p 3001:3000 -e NEXT_PUBLIC_ZEROTRUST_URL=http://host.docker.internal:3000 zerotrust-ui:latest

ARG BUN_VERSION=1.4.0
ARG NODE_VERSION=20-alpine

# ─── Stage 1: Builder ────────────────────────────────────────────────────────

FROM oven/bun:${BUN_VERSION} AS builder

WORKDIR /app

COPY package.json bun.lock bun.lockb* .bun-version ./
COPY packages/ui/package.json ./packages/ui/

RUN bun install --frozen-lockfile

COPY packages/ui ./packages/ui

WORKDIR /app/packages/ui

ARG NEXT_PUBLIC_ZEROTRUST_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_URL=http://localhost:3001
ENV NEXT_PUBLIC_ZEROTRUST_URL=${NEXT_PUBLIC_ZEROTRUST_URL}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

RUN bun run build

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/packages/ui/.next/standalone ./
COPY --from=builder /app/packages/ui/.next/static ./packages/ui/.next/static
COPY --from=builder /app/packages/ui/public ./packages/ui/public

RUN adduser -D -u 1000 zerotrust && chown -R zerotrust:zerotrust /app
USER zerotrust

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || '3000'), r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "packages/ui/server.js"]
