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

# --- Dependencies ------------------------------------------------------------
# Manifests only, so a source-only change reuses this layer.
FROM base AS deps
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- Runtime dependencies ----------------------------------------------------
# Pruned production tree for the final image. Split out from the build because
# it depends only on the manifests and the protocol source — editing a
# component must not cost a fresh 25-second resolve of 290 packages.
FROM deps AS runtime-deps
WORKDIR /repo

COPY packages/protocol packages/protocol

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @playercn/web deploy --prod --legacy /runtime

# --- Build -------------------------------------------------------------------
FROM deps AS builder
WORKDIR /repo

COPY . .

# `PUBLIC_*` values are inlined into the client bundle at build time (see
# `envPrefix` in vite.config.ts), so they have to be present here rather than
# only at runtime. Setting them in the deploy environment alone leaves the
# browser talking to its own origin, which serves no /api routes in production.
ARG PUBLIC_API_URL=""
ARG PUBLIC_WS_URL=""
ENV PUBLIC_API_URL=$PUBLIC_API_URL \
    PUBLIC_WS_URL=$PUBLIC_WS_URL \
    NODE_ENV=production

RUN pnpm --filter @playercn/web build

# --- Runtime -----------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# tini as PID 1 so SIGTERM reaches Node and the container stops promptly
# instead of waiting out Docker's 10s kill timeout on every deploy.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=runtime-deps --chown=node:node /runtime/package.json ./package.json
COPY --from=runtime-deps --chown=node:node /runtime/node_modules ./node_modules
COPY --from=builder --chown=node:node /repo/apps/web/dist ./dist
COPY --from=builder --chown=node:node /repo/apps/web/server.js ./server.js

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="playercn-web" \
      org.opencontainers.image.description="playercn web client" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
