# syntax=docker/dockerfile:1.7
#
# The build runs from the repository root so the workspace and the shared
# protocol package are both in context:
#
#   docker build -f apps/web/Dockerfile .

FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

# --- Dependencies ------------------------------------------------------------
# Manifests only, so a source-only change does not re-resolve the lockfile.
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- Build -------------------------------------------------------------------
FROM base AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/protocol/node_modules ./packages/protocol/node_modules
COPY . .

# Public config is inlined at build time, so these must be present here rather
# than only at runtime.
ARG PUBLIC_API_URL=""
ARG PUBLIC_WS_URL=""
ENV PUBLIC_API_URL=$PUBLIC_API_URL \
    PUBLIC_WS_URL=$PUBLIC_WS_URL \
    NODE_ENV=production

RUN pnpm --filter @youtube-room/web build

# --- Runtime -----------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# tini as PID 1 so SIGTERM reaches Node and the container stops promptly
# instead of waiting out Docker's 10s kill timeout on every deploy.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000

COPY --from=builder --chown=node:node /repo/apps/web/.output ./.output

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="youtube-room-web" \
      org.opencontainers.image.description="YouTube Room web client" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
