# syntax=docker/dockerfile:1.7
#
# The build runs from the repository root so the workspace and the shared
# protocol package are both in context:
#
#   docker build -f apps/web/Dockerfile .

FROM node:26-alpine AS base

# Node 26 no longer bundles corepack (`corepack enable` exits 127), so pnpm is
# installed explicitly and pinned to the same version as the `packageManager`
# field in package.json. Keep the two in step.
RUN npm install --global pnpm@11.3.0

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

# --- Build -------------------------------------------------------------------
FROM base AS builder
WORKDIR /repo

# Manifests first, so a source-only change reuses the install layer. Copying
# node_modules between stages is avoided deliberately: pnpm's store is a tree of
# relative symlinks and moving it across stages is fragile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# Public config is inlined into the bundle at build time, so these must be
# present here rather than only at runtime.
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

# The Start server output is self-contained — no node_modules needed at runtime.
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
