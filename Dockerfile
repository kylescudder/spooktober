# syntax=docker/dockerfile:1
FROM node:22-alpine AS frontend
WORKDIR /build
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts postcss.config.mjs tsconfig.json ./
COPY src/ ./src/
RUN npm run typecheck && npm test && npm run build

FROM golang:1.27.1-alpine AS backend
RUN apk add --no-cache gcc musl-dev
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY src/ ./src/
COPY --from=frontend /build/src/web/dist ./src/web/dist
RUN go test -tags sqlite_omit_load_extension ./src
RUN CGO_ENABLED=1 CGO_CFLAGS="-Os" go build -trimpath \
    -tags "netgo osusergo sqlite_omit_load_extension" \
    -ldflags="-s -w -linkmode external -extldflags -static" \
    -o /out/spooktober ./src
RUN mkdir /data && chown 10001:10001 /data

FROM scratch AS binary
COPY --from=backend /out/spooktober /spooktober

FROM scratch AS runtime
COPY --from=backend /out/spooktober /spooktober
COPY --from=backend --chown=10001:10001 /data /data
USER 10001:10001
ENV ADDR=:8080 DATABASE_PATH=/data/spooktober.sqlite GOMEMLIMIT=48MiB GOMAXPROCS=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/spooktober", "-healthcheck"]
ENTRYPOINT ["/spooktober"]
