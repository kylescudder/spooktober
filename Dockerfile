# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY next.config.ts postcss.config.mjs tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run typecheck && npm test && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ARG SPOOKTOBER_REVISION=unknown
ENV SPOOKTOBER_REVISION=$SPOOKTOBER_REVISION
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 PORT=8080 NODE_OPTIONS=--max-old-space-size=128
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/database.cjs ./database.cjs
COPY --from=build --chown=node:node /app/src/migrations ./src/migrations
COPY --from=build --chown=node:node /app/src/seed.json ./src/seed.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/healthz", {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "server.js"]
