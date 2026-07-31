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

# Manifests first, so a source-only change reuses the install layer. The
# workspace's own node_modules never leaves this stage — it is a tree of
# symlinks into /pnpm/store, which is a cache mount and therefore absent from
# the image. `pnpm deploy` below is what produces a copyable tree.
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

# Vite externalises every dependency from the SSR bundle rather than inlining
# it, so dist/server/server.js still does `import "react"` at runtime and the
# image needs a real node_modules. `pnpm deploy` builds one that is
# self-contained: prod dependencies only, workspace packages copied in rather
# than symlinked out to /repo, and every remaining link relative and internal —
# which is what makes the tree survive being copied into the next stage.
#
# --legacy is not optional: since pnpm v10, deploying a workspace that does not
# set `inject-workspace-packages=true` fails without it, and turning that on
# would change how every package in the repo links during development.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @youtube-room/web deploy --prod --legacy /runtime

# --- Runtime -----------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# tini as PID 1 so SIGTERM reaches Node and the container stops promptly
# instead of waiting out Docker's 10s kill timeout on every deploy.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# server.js resolves ./dist/server/server.js and ./dist/client relative to
# itself, so this layout has to match the one it had in the builder.
#
# package.json comes along for its `"type": "module"`: module kind is resolved
# from the nearest package.json, and without one every .js here would be read as
# CommonJS and the bundle's first `export` would be a syntax error.
COPY --from=builder --chown=node:node /runtime/package.json ./package.json
COPY --from=builder --chown=node:node /runtime/node_modules ./node_modules
COPY --from=builder --chown=node:node /repo/apps/web/dist ./dist
COPY --from=builder --chown=node:node /repo/apps/web/server.js ./server.js

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="youtube-room-web" \
      org.opencontainers.image.description="YouTube Room web client" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
