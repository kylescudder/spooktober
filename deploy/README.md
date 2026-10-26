# Spooktober on the host

## Shared deployment service

This app is registered as `spooktober` in the central deployment registry
`/Users/kyle/platform/deploy-core/apps.json`. LaunchAgent
`com.kylescudder.deploy-core` runs the single installed engine. Application hooks
are `deploy/hooks.py`; the receiver, credentials, queues,
state and database contracts below remain app-specific. Manual deployment uses
`./deploy/host-deploy.sh sha256:<digest>`.

Engine updates, application registration, failure inspection and service rollback
are documented in [deploy-core](https://github.com/kylescudder/deploy-core).
There are no vendored engine files, lock files or sync PRs. Do not install an
app-specific LaunchAgent. Apply future engine changes once through the central service.

The host is ARM macOS with Colima, not a Linux/systemd host. Read
`/Users/kyle/platform/runbook.md` and use the host deployment and operations runbooks
for the shared platform. This file owns the application's deployment commands.

## Deployer

Application-specific behavior is in `hooks.py`; deployment definitions are central.

## Actual configuration

| Item               | Value                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| Checkout           | `/Users/kyle/platform/apps/spooktober`                                         |
| Image repository   | `ghcr.io/kylescudder/spooktober`, public                                       |
| App hostname       | `spooktober.kylescudder.co.uk`                                                 |
| App upstream       | `spooktober:8080` on `platform-web`                                            |
| Database           | `spooktober`, private `postgres:5432` on internal `platform-db`                |
| Database roles     | `spooktober_owner` for migrations and grants, `spooktober_runtime` for the app |
| Hook hostname/path | `deploy.kylescudder.co.uk/hooks/spooktober`                                    |
| Hook upstream      | `spooktober-deploy-hook:9000` on `platform-web` only                           |
| Host trigger       | launchd `com.kylescudder.deploy-core`, independent app workers                 |
| Deploy identity    | Kyle, UID/GID `501:20`, owner of the Colima session                            |
| GitHub environment | `production`, restricted to branch `main`, no required reviewers               |

The receiver has a read-only root filesystem, no capabilities, no Docker socket,
no database network and no host ports. Only its queue directory is writable;
the source and webhook secret are mounted read-only. Queue files are written
and renamed within the same bind mount. The host rejects symlinks and malformed
requests, coalesces a snapshot to its newest request, and leaves later arrivals
for the next event-driven run.

The host deployer runs with Kyle's existing Docker access, rather than the
non-login Linux account proposed in the original handover. Keep its source,
configuration and private directories protected. Kyle must remain logged in
and Colima running; an unattended pre-login cold boot is not configured.

The deployer verifies provenance from this repository's `release.yml`,
`refs/heads/main` and GitHub-hosted runners before starting a new digest. It
checks the OCI revision against the signed request, exports the current list,
applies migrations and runtime grants, then uses Compose's health wait. A failed
health check restores the previous image. Migrations are not rolled back:
new migrations must remain compatible with the previous release.

Both database steps run the candidate image's bundled CLI (`node database.cjs
migrate`, then `node database.cjs grant spooktober_runtime`) as the owner, so
they never depend on loose `node_modules` in the image. `grant` verifies the
runtime role's effective privileges and fails if they are wrong, for instance
when run with the runtime login instead of the owner's.

At each step the deployer writes a sanitized record of the release to
`deploy-spool/status/<revision>-<digest>.json` (status, phase, rollback outcome
and request time only; never logs or errors). The receiver serves it to GitHub
and nothing else; full detail stays in `state/deploy.log` and
`state/last-failure.json`.

## Private configuration

Files under the checkout:

- `.env`: runtime database URL, production Clerk settings, allowed user IDs,
  public URL, actual network names and the successfully deployed image digest.
- `.env.migration`: owner/migration database URL only.
- `.env.deploy-hook`: UID/GID, web network and protected queue/secret paths.
- `secrets/clerk-production.env`: retained private production auth settings.
- `secrets/deploy-webhook-secret`: generated HMAC secret.
- `backups/hosted-watchlist-cutover.json`: authoritative hosted-list snapshot.
- `state/deployment.json`, `state/history.log`: deployed image/revision records.

Credential files are mode 0600, private directories 0700, and ignored by Git.
Project role credentials remain in `/Users/kyle/platform/projects/spooktober`.
GitHub receives only `DEPLOY_WEBHOOK_SECRET`, `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` in the `production` environment; it receives no
database, Clerk, SSH or Docker credentials. Host-side `gh` uses the existing
authenticated Kyle account; do not copy that login into the receiver or GitHub.

The first hosted import contains 20 films, three watched, with every ID, title,
order, flag and timestamp checked. The old hosted site stays available during
acceptance. Its database does not synchronize with the host: use the new address
for edits after cutover.

## Runtime configuration

On a fresh checkout, copy `.env.example` to `.env`; preserve existing private
configuration. Supply these settings at container startup, keeping owner credentials
in `.env.migration`:

| Setting                                       | Value                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                                | Restricted `spooktober_runtime` login for the `spooktober` database    |
| `CLERK_PUBLISHABLE_KEY`                       | Production instance's public `pk_live_...` key                         |
| `CLERK_SECRET_KEY`                            | Same instance's private `sk_live_...` key                              |
| `CLERK_ALLOWED_USER_IDS`                      | Kyle and Rhiann's exact production user IDs, comma separated           |
| `PUBLIC_URL`                                  | `https://spooktober.kylescudder.co.uk`                                 |
| `PLATFORM_WEB_NETWORK`, `PLATFORM_DB_NETWORK` | `platform-web`, `platform-db`                                          |
| `SPOOKTOBER_IMAGE`                            | Successfully deployed `ghcr.io/kylescudder/spooktober@sha256:<digest>` |

Percent-encode special characters in database URL credentials. `sslmode=disable`
is for the private Docker database network; use the endpoint's required TLS
configuration elsewhere. Only the Clerk publishable key reaches the browser.
The legacy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` name is also accepted, so existing runtime files need no immediate change. All settings are read at runtime; build arguments contain no credentials.

The image listens on `0.0.0.0:8080`, with a 256 MiB container limit, a 128 MiB
JavaScript heap and four database connections. Its filesystem is read-only with
a temporary `/tmp`; durable data lives in PostgreSQL. `/healthz` checks database
connectivity and access to `films`, returning 200 or 503 without film data.

## Clerk configuration

Use the existing Spooktober application, `app_3KY8TyyPWhWcj8kdLfZTH7uW56L`:

- Development instance: `ins_3KY8U3Is3W3o269nRbIVTDM86uT`.
- Production instance: `ins_3KY8wpRSWNfSvus47xrxHGyrfSW`.
- Kyle (`kyle@thescudders.org`) and Rhiann (`rhiann@thescudders.org`) already
  have accounts in both instances. Use their saved instance-specific user IDs.

Email-code sign-in is enabled; passwords, social sign-in and public registration
are disabled. Home is `/`; custom sign-in and after-sign-out paths are `/sign-in`.
The app accepts one or two exact `user_...` IDs and denies film access for missing,
malformed or duplicate entries. Keep development and production keys/users separate.

Local private `.env.clerk.production` is auth configuration only and is not loaded
automatically by the app. Merge its values with the host's protected database/network
configuration; the deployed copy is retained in `secrets/clerk-production.env`.

The production CNAME records are listed below. Check them against the existing
[production Domains page](https://dashboard.clerk.com/apps/app_3KY8TyyPWhWcj8kdLfZTH7uW56L/instances/ins_3KY8wpRSWNfSvus47xrxHGyrfSW/domains)
before changing DNS. Keep proxying off (**DNS only**) and verify DNS, TLS
certificates and email-domain verification there before release.

| Name                                           | Target                              |
| ---------------------------------------------- | ----------------------------------- |
| `clerk.spooktober.kylescudder.co.uk`           | `frontend-api.clerk.services`       |
| `accounts.spooktober.kylescudder.co.uk`        | `accounts.clerk.services`           |
| `clkmail.spooktober.kylescudder.co.uk`         | `mail.o5w90otf55dy.clerk.services`  |
| `clk._domainkey.spooktober.kylescudder.co.uk`  | `dkim1.o5w90otf55dy.clerk.services` |
| `clk2._domainkey.spooktober.kylescudder.co.uk` | `dkim2.o5w90otf55dy.clerk.services` |

The app needs outbound HTTPS/DNS to Clerk, and browsers must reach its Frontend
API at `https://clerk.spooktober.kylescudder.co.uk`. Set `PUBLIC_URL` to the exact
external HTTPS origin for session and write-origin checks. After changing keys or
allowed IDs, recreate the app and verify real login/logout for both people,
expired sessions and denial of an uninvited account.

## Install and operate

From the checkout, with private configuration already installed:

```sh
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook up -d --force-recreate --wait
launchctl print gui/501/com.kylescudder.deploy-core
tail -n 100 state/deploy.log
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook logs --tail 50
cat state/history.log
./deploy/host-deploy.sh sha256:<verified-main-digest>
```

The final command deploys or rolls back to an attested main image. Successful
releases persist their digest into `.env`, so a normal Compose restart keeps
the selected release. Pre-deploy JSON exports retain the most recent 14.

The shared supervisor scans app queues every two seconds; it does not poll GitHub. Pausing automatic requests leaves manual deployment available:

```sh
gh variable set DEPLOY_ENABLED --body false --repo kylescudder/spooktober
```

To stop the host trigger as well:

```sh
# Set only this app to enabled: false in the central apps.json registry.
```

Set this app to enabled: true to resume; existing queued requests then run. Set
`DEPLOY_ENABLED=true` only after public routing, Access and app readiness pass.

The app does not update its source checkout automatically. After reviewing and
pulling changes to `compose.yaml` or `deploy/`, recreate the receiver if its definition changed and validate the central app registry. App releases themselves use published
images; they do not build source on the host. Rotate the HMAC secret locally,
update the GitHub secret through private stdin, then recreate the receiver.

## Continuous integration and releases

Pull requests run [CI](../.github/workflows/ci.yml): deployment security checks
(deployer, receiver and release-wait tests), type checks, unit tests, the production
build, integration tests against disposable PostgreSQL 18, and an unpublished
production image build. [`test_image.py`](test_image.py) then runs the deployer's exact
migrate and grant commands inside that image against a disposable PostgreSQL
container and checks what the runtime role can and cannot do. To run it locally:
`docker build -t spooktober:ci . && SPOOKTOBER_TEST_IMAGE=spooktober:ci python3 -B -m unittest discover -s deploy -p test_image.py -v`. CI has read-only repository
access and no secrets.

Every push to `main` runs [Release](../.github/workflows/release.yml), repeats CI,
builds native `linux/amd64` and `linux/arm64` images and publishes the multi-platform
image tagged `sha-<commit>`. It signs a provenance attestation before moving `main`
to that digest. With `DEPLOY_ENABLED=true`, the deploy job first confirms the host
can report release status (so an un-updated host fails before anything is queued),
sends the signed webhook, then runs [`await_release.py`](await_release.py):

1. It polls the host's signed status endpoint for that exact digest **and** revision,
   and for that request, so another release or an earlier attempt of the same one
   is never mistaken for this one.
2. A reported failure (`failed`, or `superseded` by a newer request) fails the job
   at once, naming the phase and rollback outcome. A host that stalls or an
   unreachable receiver fails at `HOST_TIMEOUT` (15 minutes), with 10-second
   request timeouts.
3. Only after the host reports success must the public `/healthz` report the commit
   in `X-Spooktober-Revision` (`READY_TIMEOUT`, 3 minutes).

Protect `main` with required pull requests and a passing `CI / check`.

The host deployer verifies the digest before running it. For independent verification:

```sh
gh attestation verify oci://ghcr.io/kylescudder/spooktober@sha256:<digest> --bundle-from-oci \
  --repo kylescudder/spooktober \
  --signer-workflow kylescudder/spooktober/.github/workflows/release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

Compose uses `SPOOKTOBER_IMAGE` for the published digest and defaults to
`spooktober:local` for a local `docker compose build`. Use the host deployer for
production releases so migrations, backups and rollback checks run together.

## Cloudflare routes and authentication

Create a self-hosted Access application for `deploy.kylescudder.co.uk`, leaving
Path empty. Attach exactly one Service Auth policy including Service Token
`github-spooktober-deploy`; enable the 401 response for Service Auth policies.
Record the token's expiry from the dashboard. The tunnel management certificate
cannot create Access credentials, and is not a substitute for this service token.

Register the hook through the shared platform command, never by editing its
managed Caddy block:

```sh
cd /Users/kyle/platform
python3 -B scripts/hostname.py add spooktober-deploy deploy.kylescudder.co.uk --upstream spooktober-deploy-hook:9000 --path /hooks/spooktober
python3 -B scripts/hostname.py add spooktober spooktober.kylescudder.co.uk --upstream spooktober:8080
```

The hook's Caddy route returns 404 for every other path, including its private
health endpoint. Unauthenticated requests must be denied by Access before
reaching the receiver. The release job checks this, tests authenticated 404s
for other paths, and verifies that an incorrect HMAC signature returns 401
from the receiver. Its response marker distinguishes an origin 401 from an
Access denial. The valid signed request must return 202, then the job waits
for the host's status and the app's public `/healthz` revision as described above.

The status endpoint is `GET /hooks/spooktober?digest=…&revision=…&timestamp=…` on the
same hostname and path as the webhook, so no routing change is needed. It sits
behind the same Access service token and also requires an HMAC over
`status\n<digest>\n<revision>\n<timestamp>` (a webhook signature cannot be replayed
against it) and a timestamp within five minutes. It returns only fixed-vocabulary fields.

Clerk's production domain CNAMEs are DNS-only and separate from the tunnel.
The runtime allows only Kyle and Rhiann's existing production user IDs.
Anonymous requests reveal no film data.

Preserve session cookies, `Authorization`, `Origin`, `X-Spooktober-Request` and
the external host/forwarded HTTPS information. Honor private/no-store caching for
HTML and `/api/trpc`; bypass Cloudflare caching for authenticated pages and API
responses. Public artwork and Vite static assets may be cached. The app uses
Clerk directly; additional Basic Auth challenges interfere with sign-in.

## Database maintenance

Normal startup applies neither migrations nor seed data. The host deployer runs
migrations and grants automatically. For manual setup or recovery, use the intended
verified image with the owner login on the private database network:

```sh
chmod 600 .env .env.migration
docker run --rm --read-only --network platform-db --env-file .env.migration \
  ghcr.io/kylescudder/spooktober@sha256:<digest> node database.cjs migrate
```

Apply runtime grants with the same owner login and image (idempotent):

```sh
docker run --rm --read-only --network platform-db --env-file .env.migration \
  ghcr.io/kylescudder/spooktober@sha256:<digest> node database.cjs grant spooktober_runtime
```

This gives `spooktober_runtime` read/insert/update on `films`, no access to the
Drizzle migration journal (schema `drizzle`), and no delete or schema changes.
Databases from before Drizzle keep a read-only `schema_migrations`, so a rollback
to those releases still starts.

For an empty migrated database, keep the app stopped and choose either a seed
for a fresh list or an import from a private snapshot:

```sh
docker compose run --rm --no-deps spooktober node database.cjs seed
docker compose run --rm --no-deps -T spooktober node database.cjs import - < backups/hosted-watchlist-cutover.json
```

Seed/import refuse to overwrite populated target years; invalid imports are atomic.
JSON array order defines film positions within each year, with IDs and watched flags retained.
Timestamps normalize to UTC with nanosecond precision; unknown viewing dates
remain `null`. Existing populated PostgreSQL data can be used directly.

For a private portable JSON snapshot of every season:

```sh
umask 077
docker compose exec -T spooktober node database.cjs export - > watchlist-backup.json
```

The default export includes `year` on every film and covers historical and future
seasons even when this year's list is empty. Pre-deploy backups use this command,
validate year associations before promoting the snapshot, and only then rotate
older backups. The first upgrade also accepts untagged backups from the original
single-season image; restore those with `import --year 2026`.

Check the export's exit status before using it as a backup. Restore an all-season
snapshot with `node database.cjs import - < watchlist-backup.json` into an empty
migrated database: years, order, progress and timestamp precision are preserved
in one transaction. `export - --year 2026` instead exports one season without
year tags; restore it with `import - --year 2026`. Seed and untagged imports
default to the current year. Imports reject mixed tagged/untagged records,
conflicting `--year`, duplicate IDs and populated target years. Limits are
16 MiB, 100000 films total and 1000 per season. Local source commands use `bun run db` with
the same `migrate`, `seed`, `import` and `export` arguments. For local PostgreSQL
and app startup, follow the [root README](../README.md#run-locally-with-docker).

## Backups and acceptance

Shared encrypted NAS backups run Sunday 03:00 Europe/London and keep one latest
successful archive at `/Volumes/kyle/Backups/herman-platform-latest.tar.gz.age`.
They contain the project PostgreSQL dump, role credentials, deployment settings,
private app secrets, deploy tooling and successful image/history records.
Use the host operations runbook and `/Users/kyle/platform/backups/operations.md` for recovery.

Back up before schema changes and test restores in a separate database, including
migration history. Keep the previous image and roll back only to a compatible
schema. Preserve the latest data before recovery; an older snapshot would discard
subsequent edits.

Verification records live under `/Users/kyle/platform/verification`. Do not
mark automatic deployment complete until a main merge's Release deploy job is
green and public health reports that same 40-character revision. Real
Kyle/Rhiann login, logout and simultaneous edits require their actual sessions;
trusted-session integration tests alone do not establish that manual acceptance.

## Database connection budget

The runtime role is limited to eight PostgreSQL connections. Application work
uses at most four, health checks at most one, and deployment verification or
database CLI work at most one. Sequential deployment commands use their own
one-connection client instead of importing the application pool. This leaves
two slots for operator connections during a release; owner migrations use a
separate role.

CI exercises the real deployment client against an eight-connection test role,
with all four application slots held open. Concurrent deployment queries must
share one backend, health must still connect, two spare slots must remain usable,
and a ninth connection must be rejected by PostgreSQL.
