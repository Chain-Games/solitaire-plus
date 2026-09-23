# Multi-stage: the runtime image carries the built server, the built client,
# and production dependencies only.
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM fetch AS build
COPY . .
RUN CI=1 pnpm install --offline --frozen-lockfile
RUN pnpm --filter @solitaire-plus/sim build \
 && pnpm --filter @solitaire-plus/server build \
 && pnpm --filter @solitaire-plus/client build

FROM fetch AS prod-deps
COPY package.json ./
COPY packages/sim/package.json packages/sim/
COPY apps/server/package.json apps/server/
# CI=1: pnpm otherwise asks "modules will be reinstalled, proceed?" and, with no
# TTY, exits without installing — the runtime image then had no node_modules.
RUN CI=1 pnpm install --offline --frozen-lockfile --prod --filter @solitaire-plus/server...

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
# The sim has no runtime dependencies, so pnpm creates no node_modules for it.
COPY --from=build /app/packages/sim/package.json ./packages/sim/package.json
COPY --from=build /app/packages/sim/dist ./packages/sim/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/client/dist ./apps/server/public
ENV STATIC_DIR=/app/apps/server/public
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
