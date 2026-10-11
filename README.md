# Spooktober

Kyle and Rhiann's shared Halloween film watchlist. **Next.js + React + TypeScript, tRPC, Zod and PostgreSQL.** One application lives in `src/`; one Node.js process renders the page and handles film changes.

- Cosy pumpkin-and-candle styling, with phone and keyboard controls.
- The current film list is rendered on the server; React handles dragging, checkboxes and adding films.
- Clerk provides sign-in; only Kyle and Rhiann's configured user IDs can read or change films.
- tRPC shares API input/output types with the client; Zod validates requests, responses and JSON imports.
- PostgreSQL saves synchronize through a refresh every 15 seconds and when a page regains focus.
- Concurrent writes coordinate across app instances. Add retries do not duplicate films; stale reorders retain additions.
- Twenty supplied films can be explicitly seeded, with Scream 7, Iron Lung and Primate already watched.

```text
src/
  app/                       # Next.js page, layout, tRPC endpoint and health route
  proxy.ts                   # Clerk session middleware and request protection
  film-list.tsx              # Interactive React watchlist
  server/                    # PostgreSQL, tRPC router, maintenance commands and tests
  lib/, components/          # Shared Zod schemas, typed client and UI components
  styles.css, vendor/        # Styling
  migrations/, seed.json     # Existing PostgreSQL schema and original film list
public/                      # Artwork and favicon for this app
Dockerfile, compose.yaml     # Production app using the shared platform
compose.dev.yaml             # Local app and development PostgreSQL
.next/                       # Generated Next.js build, ignored by Git
```

## Sign-in with Clerk

The Spooktober Clerk application has development and production instances, with accounts for **kyle@thescudders.org** and **rhiann@thescudders.org** in each. Both instances use email-code sign-in, with passwords, social sign-in and public registration disabled. Production is configured for **spooktober.kylescudder.co.uk**; its DNS and certificates remain to be completed in [the Spooktober setup plan](docs/spooktober-setup-plan.md#clerk-already-provisioned).

This checkout's development keys and user IDs are saved in private `.env`. The private `.env.clerk.production` holds production Clerk keys, production user IDs and `PUBLIC_URL`; merge it into the server's protected runtime configuration when deploying. It does not contain database credentials and Next.js does not load that filename automatically. Neither file is committed or included in Docker builds. On a fresh checkout, obtain these values privately from the existing Clerk application. The app permits one or two exact `user_...` IDs and rejects missing, malformed or duplicate entries. Production users have different IDs from development users.

The app has a cosy `/sign-in` page and an account menu with sign-out. An authenticated user outside the configured pair sees an access-denied page and cannot use the API. The server-rendered page and every tRPC procedure check access independently of middleware. Sign-up links are hidden in the app; accounts are managed through Clerk. The app's user-ID checks enforce private access without relying on Clerk's paid identifier allowlist feature.

Missing keys show a setup message and deny film API access. There is no Basic Auth fallback or automatic creation of a Clerk application. Builds require neither Clerk keys nor database access; the Docker image receives configuration at startup. Only the publishable key is sent to the browser. **The app and film database are self-hosted; Clerk hosts identity and sessions.** Live login needs network access to Clerk.

See [the Clerk setup steps in deployment instructions](docs/deployment.md#configure-clerk) before production release.

## Run locally with Docker

On a fresh checkout, copy `.env.example` to `.env` and configure Clerk as described below. Preserve an existing private `.env`. The local Compose file supplies a development-only PostgreSQL connection and clears `PUBLIC_URL` for localhost.

```sh
docker compose -f compose.dev.yaml up -d postgres
docker compose -f compose.dev.yaml build
docker compose -f compose.dev.yaml run --rm spooktober node database.cjs migrate
docker compose -f compose.dev.yaml run --rm spooktober node database.cjs seed
docker compose -f compose.dev.yaml up -d spooktober
```

Open <http://localhost:8080>. Seed once for a fresh list, or use `node database.cjs import -` with an exported JSON list instead. Seed/import refuse to replace populated data. Normal startup applies neither migrations nor seed data. `docker compose -f compose.dev.yaml down` retains the development database volume.

## Develop with Node.js

Use Node.js 22.13 or newer. Start only the local PostgreSQL service above, run `npm ci`, and set the following development connection in your private `.env`, alongside your Clerk settings:

```dotenv
DATABASE_URL=postgres://spooktober_owner:local-development-only@127.0.0.1:54329/spooktober?sslmode=disable
PUBLIC_URL=
```

```sh
npm run db -- migrate
npm run db -- seed
npm run dev
```

Skip seed if the database already contains your list. Next.js serves the page and tRPC from <http://localhost:8080>; no separate backend process is needed. `npm run build` and `npm start` run a production build locally. Database credentials remain server-only and are read at runtime, so building requires no PostgreSQL connection.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

Integration tests require a disposable PostgreSQL cluster with a privileged test login. They create uniquely named databases; the control database must end in `_test`. With the local development cluster:

```sh
docker compose -f compose.dev.yaml exec postgres createdb -U spooktober_owner spooktober_test
TEST_DATABASE_URL='postgres://spooktober_owner:local-development-only@127.0.0.1:54329/spooktober_test?sslmode=disable' npm run test:integration
```

Create the control database once. Tests cover migrations, restricted runtime permissions, typed tRPC transport, trusted-session access policy and origin protection, simultaneous changes across pools, and atomic JSON import/export with timestamp precision. The image build runs type checks and database-independent tests; run integration checks before releasing. These tests exercise the server access policy with trusted session fixtures; verify real Clerk login, logout and session expiry separately with configured keys.

## Self-hosting

1. [Hermes: configure the shared infrastructure](docs/hermes-infrastructure-plan.md): PostgreSQL, Docker Compose, Caddy, Cloudflare Tunnel and backups, including static and server-rendered Astro support from the initial delivery.
2. [Set up Spooktober](docs/spooktober-setup-plan.md): provision its database, run migrations, import the film list and publish this Next.js app on that platform.

Production runs one Next.js container using the shared PostgreSQL server. It joins the platform's existing web/database networks and publishes no host port. The image uses Next.js standalone output, with a 256 MiB container limit and a four-connection database pool. See [deployment instructions](docs/deployment.md) for the exact commands and runtime configuration. No Vercel account or Go toolchain is needed.

The PostgreSQL schema is unchanged by this framework migration. Existing PostgreSQL data can be used directly. For the old hosted watchlist, refresh the private JSON export before cutover and import it into an empty migrated database.

## Artwork

The [pumpkin-and-candle illustration](public/images/pumpkins-and-candles.png) was created with built-in imagegen. Prompt: two warm orange pumpkins, one small gently smiling jack-o-lantern, two ivory candles with amber flames and autumn leaves; a hand-painted vintage storybook/gouache vignette, rich pumpkin orange, warm cream and brown shadows, transparent background, no text or logos. Generated at 1536 × 1024.
