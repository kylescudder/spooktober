# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2-alpine AS bun

FROM node:22-alpine AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY vite.config.ts tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY public/ ./public/
RUN bun run typecheck && bun run test && bun run build

FROM node:22-alpine AS runtime
WORKDIR /app
ARG SPOOKTOBER_REVISION=unknown
ENV SPOOKTOBER_REVISION=$SPOOKTOBER_REVISION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 NODE_OPTIONS=--max-old-space-size=128
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/.output/database.cjs ./database.cjs
COPY --from=build --chown=node:node /app/src/migrations ./src/migrations
COPY --from=build --chown=node:node /app/src/seed.json ./src/seed.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/healthz", {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", ".output/server/index.mjs"]
