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

# Manifests first, so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# `NEXT_PUBLIC_*` values are inlined into the client bundle at build time, so
# they have to be present here rather than only at runtime. Setting them in the
# deploy environment alone leaves the browser talking to its own origin, which
# serves no /api routes in production.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_WS_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN pnpm --filter @playercn/web build

# --- Runtime -----------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# tini as PID 1 so SIGTERM reaches Node and the container stops promptly
# instead of waiting out Docker's 10s kill timeout on every deploy.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: 'standalone'` already produced a traced node_modules and its own
# server.js, so there is no install step here. It deliberately does *not*
# include static assets or public files — those are copied separately, and
# missing either one yields a server that boots and then serves an unstyled
# page with no JavaScript.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="playercn-web" \
      org.opencontainers.image.description="playercn web client" \
      org.opencontainers.image.licenses="MIT"

# For a workspace package the standalone server lands at the path it occupied
# in the repo, not at the root of the output.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
