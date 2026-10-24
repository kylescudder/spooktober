# Spooktober

Kyle and Rhiann's shared Halloween film watchlist. **TanStack Start + TanStack Router + React + TypeScript, tRPC, Zod and PostgreSQL.** One application lives in `src/`; one Node.js process renders the page and handles film changes.

- Cosy pumpkin-and-candle styling, with phone and keyboard controls.
- The current film list is rendered on the server; React handles dragging, checkboxes and adding films.
- The year picker defaults to the current calendar year. Each year's films, order and progress are separate; `?year=2026` links to a specific season and survives reloads. The picker includes 2020 through next year (and any year opened directly).
- Clerk provides sign-in; only Kyle and Rhiann's configured user IDs can read or change films.
- tRPC shares API input/output types with the client; Zod validates requests, responses and JSON imports.
- PostgreSQL saves synchronize through a refresh every 15 seconds and when a page regains focus.
- Concurrent writes coordinate across app instances. Add retries do not duplicate films; stale reorders retain additions.
- Twenty supplied films can be explicitly seeded, with Scream 7, Iron Lung and Primate already watched.

```text
src/
  routes/                    # TanStack Router pages, tRPC endpoint and health route
  router.tsx, start.ts        # Router and request middleware configuration
  film-list.tsx              # Interactive React watchlist
  server/                    # PostgreSQL, tRPC router, maintenance commands and tests
  lib/, components/          # Shared Zod schemas, typed client and UI components
  styles.css, vendor/        # Styling
  migrations/, seed.json     # Existing PostgreSQL schema and original film list
public/                      # Artwork and favicon for this app
Dockerfile, compose.yaml     # Production app using the shared platform
compose.dev.yaml             # Local app and development PostgreSQL
.output/                     # Generated Nitro production server and assets, ignored by Git
```

## Sign-in with Clerk

The Spooktober Clerk application has development and production instances, with accounts for **kyle@thescudders.org** and **rhiann@thescudders.org** in each. Both instances use email-code sign-in, with passwords, social sign-in and public registration disabled. Production is configured for **spooktober.kylescudder.co.uk**; see [Clerk configuration](deploy/README.md#clerk-configuration) for the existing instances and production DNS/certificate checks.

Save development keys and user IDs in private `.env`. The private `.env.clerk.production` holds production Clerk keys, production user IDs and `PUBLIC_URL`; merge it into the server's protected runtime configuration when deploying. It does not contain database credentials and the app does not load that filename automatically. Neither file is committed or included in Docker builds. On a fresh checkout, obtain these values privately from the existing Clerk application. The app permits one or two exact `user_...` IDs and rejects missing, malformed or duplicate entries. Production users have different IDs from development users.

The app has a cosy `/sign-in` page and an account menu with sign-out. An authenticated user outside the configured pair sees an access-denied page and cannot use the API. The server-rendered page and every tRPC procedure check access independently of middleware. Sign-up links are hidden in the app; accounts are managed through Clerk. The app's user-ID checks enforce private access without relying on Clerk's paid identifier allowlist feature.

Missing keys show a setup message and deny film API access. There is no Basic Auth fallback or automatic creation of a Clerk application. Use `CLERK_PUBLISHABLE_KEY` for the public key. The old `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` name remains supported at runtime so existing deployments keep working; no key is baked into Vite client assets. Builds require neither Clerk keys nor database access; the Docker image receives configuration at startup. Only the publishable key is sent to the browser. **The app and film database are self-hosted; Clerk hosts identity and sessions.** Live login needs network access to Clerk.

See [runtime configuration](deploy/README.md#runtime-configuration) and [Clerk configuration](deploy/README.md#clerk-configuration) before production release.

## Run locally with Docker

On a fresh checkout, copy `.env.example` to `.env` and configure Clerk as described below. Preserve an existing private `.env`. The local Compose file supplies a development-only PostgreSQL connection and clears `PUBLIC_URL` for localhost.

```sh
docker compose -f compose.dev.yaml up -d postgres
docker compose -f compose.dev.yaml build
docker compose -f compose.dev.yaml run --rm spooktober node database.cjs migrate
docker compose -f compose.dev.yaml run --rm spooktober node database.cjs seed
docker compose -f compose.dev.yaml up -d spooktober
```

Open <http://localhost:8080>. Seed once for a fresh list, or use `node database.cjs import -` with an exported JSON list instead. Seed/import refuse to replace a populated year. Normal startup applies neither migrations nor seed data. `docker compose -f compose.dev.yaml down` retains the development database volume.

Migration `002_annual_watchlists.sql` assigns the original shared list to **2026**, preserving its order, watched status and timestamps. Run `db migrate` as the schema owner before starting this version. Other seasons start empty. `export` without `--year` backs up **all seasons**, including a `year` on every film; `import` restores those year associations and each season's order in one transaction. Supply `--year 2026` to export a single season, for example `bun run db export /tmp/spooktober-2026.json --year 2026`. Single-season exports omit the year, so supply the same `--year` when restoring. Seed and untagged imports default to the current year. Tagged imports with an explicit `--year` reject any other season. All target years must be empty, and film IDs remain globally unique; imports refuse reused IDs. Explicit seeding in another year generates fresh IDs.

## Develop with Bun

Use Bun 1.4.2 for package management and Node.js 22.13 or newer for the app and test runtime. Start only the local PostgreSQL service above, run `bun install --frozen-lockfile`, and set the following development connection in your private `.env`, alongside your Clerk settings:

```dotenv
DATABASE_URL=postgres://spooktober_owner:local-development-only@127.0.0.1:54329/spooktober?sslmode=disable
PUBLIC_URL=
```

```sh
bun run db migrate
bun run db seed
bun run dev
```

Skip seed if the database already contains your list. TanStack Start serves the page and tRPC from <http://localhost:8080>; no separate backend process is needed. `bun run build` and `bun run start` run a production build locally. Database credentials remain server-only and are read at runtime, so building requires no PostgreSQL connection.

## Checks

```sh
bun run typecheck
bun run test
bun run build
bunx --no-install playwright install chromium
bun run test:e2e
```

To include authenticated watchlist UI coverage against real PostgreSQL, set `E2E_WATCHLIST_DATABASE_URL` to a disposable control database ending in `_test` when running `bun run test:e2e`. The test-only Vite host creates its own database and mounts the production watchlist route, with Clerk replaced at the existing trusted-session seam and the server loader replaced by an API read. Tests exercise the real tRPC transport, validation and storage, covering the current-year default (including a new calendar year), year URLs/reloads/history, independent lists/progress/order, and failed-save retry at desktop/mobile sizes. This fixture is absent from production builds and does not verify real Clerk login or server rendering of an authenticated season.

Integration tests require a disposable PostgreSQL cluster with a privileged test login. They create uniquely named databases; the control database must end in `_test`. With the local development cluster:

```sh
docker compose -f compose.dev.yaml exec postgres createdb -U spooktober_owner spooktober_test
TEST_DATABASE_URL='postgres://spooktober_owner:local-development-only@127.0.0.1:54329/spooktober_test?sslmode=disable' bun run test:integration
```

Create the control database once. Tests cover migrations, restricted runtime permissions, typed tRPC transport, trusted-session access policy and origin protection, simultaneous changes across pools, and atomic JSON import/export with timestamp precision. The Playwright suite covers setup pages at desktop/mobile sizes, metadata, unknown routes, readiness, fail-closed API responses without Clerk keys, and signed-out redirects/API denials through Clerk’s actual server middleware using nonfunctional fixture keys. Set `E2E_DATABASE_URL` to a disposable migrated PostgreSQL database to verify healthy readiness; otherwise it checks the unavailable response. Real Clerk login and authenticated browser editing require the existing application’s private test credentials and are not simulated.

The image build runs type checks and database-independent tests; run integration checks before releasing. These tests exercise the server access policy with trusted session fixtures; verify real Clerk login, logout and session expiry separately with configured keys.

## Self-hosting

Production runs on the host (ARM macOS with Colima), using the shared PostgreSQL server, Caddy and Cloudflare Tunnel. The [host operating guide](deploy/README.md) contains runtime configuration, deployment, database maintenance and recovery instructions; shared infrastructure is maintained in `/Users/kyle/platform/runbook.md`.

One TanStack Start container joins the platform's existing web/database networks and publishes no host port. The image uses Nitro’s standalone Node.js output, with a 256 MiB container limit and a four-connection database pool. Pushes to `main` are checked, published to GHCR and deployed to the host by GitHub Actions; see [CI and releases](deploy/README.md#continuous-integration-and-releases).

Run all pending PostgreSQL migrations before starting the application. For the old hosted watchlist, refresh the private JSON export before cutover and import it into an empty season with `--year 2026`.

## Artwork

The [pumpkin-and-candle illustration](public/images/pumpkins-and-candles.png) was created with built-in imagegen. Prompt: two warm orange pumpkins, one small gently smiling jack-o-lantern, two ivory candles with amber flames and autumn leaves; a hand-painted vintage storybook/gouache vignette, rich pumpkin orange, warm cream and brown shadows, transparent background, no text or logos. Generated at 1536 × 1024.
