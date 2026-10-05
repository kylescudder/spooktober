# Spooktober

Kyle and Rhiann's shared Halloween film watchlist. One application lives in `src/`: a React interface and a Go HTTP server with its database access, seed and migrations. Build and deployment configuration live at the repository root.

- Cosy pumpkin-and-candle styling, with phone and keyboard controls.
- Twenty supplied films. Scream 7, Iron Lung and Primate start watched.
- Drag to reorder, tick or untick watched films, and add films.
- Basic Auth protects the page, assets and film API.
- Shared saves persist across restarts; the list refreshes every 15 seconds and when a page regains focus.

```text
src/
  main.go, server.go, storage.go   # HTTP server and database operations
  main.tsx, film-list.tsx         # React interface
  styles.css, components/, lib/   # Styling, UI components and validation
  migrations/, seed.json          # Database schema and initial list
  public/, vendor/                # Artwork, favicon and vendored styles
  web/dist/                       # Generated browser build, ignored by Git
Dockerfile, compose.yaml           # Application deployment
package.json, go.mod               # Build dependencies
docs/, deploy/                     # Handoff, deployment guide and service file
```

## Run

On a fresh checkout, create `.env` from `.env.example` and set `BASIC_AUTH_USERNAME` and a long random `BASIC_AUTH_PASSWORD`. This working checkout already has a private `.env` containing the existing login.

```sh
docker compose up -d --build
```

Open <http://localhost:8080>. The image contains one executable with the UI embedded; SQLite currently stores the shared list in a persistent volume. Set `PUBLIC_URL` to the exact HTTPS origin when putting the app behind Caddy.

See the [current SQLite runtime guide](docs/deployment.md) for this build's import, backup and standalone commands. For shared-platform deployment, follow the two plans below. The private `data/hosted-watchlist.json` snapshot preserves the exported film order and watched state; refresh it before final cutover.

## Development

Use Node.js 22.13 or newer. Native backend builds also require Go 1.27 and a C compiler for SQLite. The Docker build supplies the toolchain and runs the checks.

```sh
npm ci
npm run typecheck
npm test
npm run build
go test -tags sqlite_omit_load_extension ./src
go build -tags sqlite_omit_load_extension -o artifacts/spooktober ./src
```

For browser development, start the Go server with the Basic Auth credentials in its environment, then run `npm run dev` in another terminal. Vite proxies API calls to the Go server on port 8080.

Film status and order save independently. Failed optimistic saves revert visibly and can be retried. Add retries reuse the same identifier, and a reorder retains films added by another viewer. HTTP writes require same-origin JSON requests and a custom request header.

## Self-hosting plans

1. [Hermes: configure the shared infrastructure](docs/hermes-infrastructure-plan.md). Deploy shared PostgreSQL, Docker Compose, Caddy, Cloudflare Tunnel and backups. Deliver and verify static and server-rendered Astro hosting in this initial phase, then return the platform handoff.
2. [Set up Spooktober](docs/spooktober-setup-plan.md). After the platform is accepted, implement PostgreSQL storage in this app, deploy it using the existing infrastructure, and transfer the film list.

Send Hermes the first plan now. The second plan consumes the completed platform's commands and configuration. The current SQLite app needs the PostgreSQL code change described in that second plan before deployment on the shared database.

## Artwork

The [pumpkin-and-candle illustration](src/public/images/pumpkins-and-candles.png) was created with built-in imagegen. Prompt: two warm orange pumpkins, one small gently smiling jack-o-lantern, two ivory candles with amber flames and autumn leaves; a hand-painted vintage storybook/gouache vignette, rich pumpkin orange, warm cream and brown shadows, transparent background, no text or logos. Generated at 1536 × 1024.
