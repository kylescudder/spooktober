# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS bun

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV HUSKY=0
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY vite.config.ts tsconfig.json eslint.config.js ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY public/ ./public/
COPY drizzle/ ./drizzle/
RUN bun run typecheck && bun run lint && bun run test && bun run build

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
WORKDIR /app
ARG SPOOKTOBER_REVISION=unknown
ENV SPOOKTOBER_REVISION=$SPOOKTOBER_REVISION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 NODE_OPTIONS=--max-old-space-size=128
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/.output/database.cjs ./database.cjs
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/src/seed.json ./src/seed.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/healthz", {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", ".output/server/index.mjs"]
