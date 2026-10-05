# Current SQLite runtime guide

This guide describes the existing SQLite build for development or standalone use. For the shared PostgreSQL platform, complete [Plan 1: configure infrastructure](hermes-infrastructure-plan.md), then follow [Plan 2: set up Spooktober](spooktober-setup-plan.md). Plan 2 includes the PostgreSQL code change and updates this guide to the deployed release.

The application source is in `src/`. One Go process serves the React interface and its API. SQLite runs inside that process and stores the shared watchlist in one file. The production container contains a statically linked executable with the website embedded in it, running as an unprivileged user. Node, npm, Go, compilers and framework servers are only needed to build it. There are no external services or calls to ChatGPT in this runtime.

For the smallest server footprint, build on another machine and copy the standalone executable onto the server. This avoids installing Docker or retaining compiler/build caches on the server. Docker runs the same executable when you already have Docker installed.

## Docker

On a fresh checkout, from the repository root:

```sh
cp .env.example .env
```

Set `BASIC_AUTH_USERNAME` and a long random `BASIC_AUTH_PASSWORD` in `.env`. Docker Compose reads this ignored file; never commit it. This checkout already has a private `.env` with the same login as the hosted version. The server refuses to start with missing credentials or the example password.

```sh
docker compose up -d --build
```

Open <http://localhost:8080>. The supplied 20 films are added once on first startup. Scream 7, Iron Lung and Primate start watched. A named Docker volume retains changes across restarts and image upgrades. The app is limited to 64 MiB of memory; the default port binding is accessible on the host itself.

For phone access, put the app behind your existing HTTPS reverse proxy and set `PUBLIC_URL=https://films.example.com` to that exact public origin in `.env`. Proxy requests to `127.0.0.1:8080`, forwarding the browser's `Authorization` header. For a proxy in another Docker container, connect both containers to your proxy's Docker network and use `spooktober:8080` as the upstream. HTTPS protects the Basic Auth login in transit.

After changing `.env`, run `docker compose up -d` to recreate the container with the new values. The database stays in its volume.

```sh
docker compose logs --tail=30
docker compose ps
docker compose down
```

`down` keeps your database. Adding `--volumes` deletes it.

## Move the current hosted list across

A private snapshot of the live hosted watchlist is saved in `data/hosted-watchlist.json` in this checkout. It preserves the current viewing order, watched flags and dates. This file is ignored by Git and excluded from the Docker build; copy it privately to your server along with `.env`. Import it into a fresh volume **before** the first normal startup:

```sh
docker compose build
docker compose run --rm --no-deps -T spooktober -import - -init < data/hosted-watchlist.json
docker compose up -d
```

Import refuses to overwrite an existing nonempty database. To import after testing, use a separate fresh Compose project or volume. The cloud and self-hosted databases are independent after this snapshot; choose the self-hosted address for subsequent watching. Leave the hosted version available until you have checked your own deployment.

## Backup and restore

The executable exports a consistent JSON snapshot using the same SQLite locking as the running server. The snapshot includes film identifiers, order, watched dates and timestamps.

```sh
docker compose exec -T spooktober /spooktober -export /data/watchlist-backup.json
docker compose cp spooktober:/data/watchlist-backup.json ./watchlist-backup.json
chmod 600 watchlist-backup.json
```

Restore to an empty volume using the import command above, replacing the input filename with your backup. Protect backups and credentials when copying them off the host.

## Standalone Linux executable

Build on a machine with Docker, then copy the resulting executable to a Linux host of the same CPU architecture:

```sh
docker build --target binary --output type=local,dest=artifacts/bin .
```

For a different host architecture, add `--platform linux/amd64` or `--platform linux/arm64`. Cross-platform builds need Docker's platform emulation. The executable includes SQLite and all browser assets and runs without Docker, Node, Go or shared libraries.

For a quick local run, configure `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` as environment variables and run:

```sh
./spooktober -addr 127.0.0.1:8080 -db ./data/spooktober.sqlite
```

For systemd, install the executable at `/usr/local/bin/spooktober`, put your environment settings in a root-readable `/etc/spooktober.env`, and install [`spooktober.service`](../deploy/spooktober.service) at `/etc/systemd/system/spooktober.service`. The service creates its own user and stores the database under `/var/lib/spooktober`.

```sh
sudo chmod 600 /etc/spooktober.env
sudo systemctl daemon-reload
sudo systemctl enable --now spooktober
```

## Development and verification

Run all commands from the repository root. The React interface, Go server, seed and migrations live together in `src/`, with one npm package and root build configuration. Build the browser assets before compiling the Go executable:

```sh
npm ci
npm run typecheck
npm test
npm run build
go test -tags sqlite_omit_load_extension ./src
go build -tags sqlite_omit_load_extension -o artifacts/spooktober ./src
```

Native builds need Go 1.27 and a C compiler for SQLite. The Docker build installs those in build stages, runs the Go tests and copies only the final executable into an otherwise empty image. All routes and assets require Basic Auth except `/healthz`, which returns a plain health status for the container healthcheck. Mutations reject cross-origin requests and use prepared SQL inside transactions; concurrent reorders preserve newly added films. Existing watched films with unknown viewing dates retain `null` dates.

For UI development, first run `npm run build`, then start `go run -tags sqlite_omit_load_extension ./src` with Basic Auth credentials in its environment. Run `npm run dev` in another terminal. Vite proxies `/api` requests to the Go server on port 8080. Production requests go through the Go server, which serves the embedded build under `src/web/dist`.
