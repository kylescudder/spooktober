# Spooktober on Herman

Herman is ARM macOS with Colima, not a Linux/systemd host. Read
`/Users/kyle/platform/runbook.md` and use the `herman-deploy` / `herman-ops` skills
for the shared platform. This file owns the application's deployment commands.

## Actual configuration

| Item | Value |
| --- | --- |
| Checkout | `/Users/kyle/platform/apps/spooktober` |
| Image repository | `ghcr.io/kylescudder/spooktober`, public |
| App hostname | `spooktober.kylescudder.co.uk` |
| App upstream | `spooktober:8080` on `platform-web` |
| Database | `proj_spooktober`, private `postgres:5432` on internal `platform-db` |
| Database roles | `proj_spooktober_owner` for migrations, `proj_spooktober_runtime` for the app |
| Hook hostname/path | `deploy.kylescudder.co.uk/hooks/spooktober` |
| Hook upstream | `spooktober-deploy-hook:9000` on `platform-web` only |
| Host trigger | launchd `com.herman.spooktober-deploy`, `QueueDirectories` |
| Deploy identity | Kyle, UID/GID `501:20`, owner of the Colima session |
| GitHub environment | `production`, restricted to branch `main`, no required reviewers |

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
acceptance. Its database does not synchronize with Herman: use the new address
for edits after cutover.

## Runtime configuration

On a fresh checkout, copy `.env.example` to `.env`; preserve existing private
configuration. Supply these settings at container startup, keeping owner credentials
in `.env.migration`:

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | Restricted runtime login for `proj_spooktober` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Production instance's public `pk_live_...` key |
| `CLERK_SECRET_KEY` | Same instance's private `sk_live_...` key |
| `CLERK_ALLOWED_USER_IDS` | Kyle and Rhiann's exact production user IDs, comma separated |
| `PUBLIC_URL` | `https://spooktober.kylescudder.co.uk` |
| `PLATFORM_WEB_NETWORK`, `PLATFORM_DB_NETWORK` | `platform-web`, `platform-db` |
| `SPOOKTOBER_IMAGE` | Successfully deployed `ghcr.io/kylescudder/spooktober@sha256:<digest>` |

Percent-encode special characters in database URL credentials. `sslmode=disable`
is for the private Docker database network; use the endpoint's required TLS
configuration elsewhere. Only the Clerk publishable key reaches the browser.
All settings are read at runtime; build arguments contain no credentials.

The image listens on `0.0.0.0:8080`, with a 256 MiB container limit, a 128 MiB
JavaScript heap and four database connections. Its filesystem is read-only with
a temporary `/tmp`; durable data lives in PostgreSQL. `/healthz` checks database
connectivity and migration history, returning 200 or 503 without film data.

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
automatically by Next.js. Merge its values with the host's protected database/network
configuration; the deployed copy is retained in `secrets/clerk-production.env`.

The production CNAME records are listed below. Check them against the existing
[production Domains page](https://dashboard.clerk.com/apps/app_3KY8TyyPWhWcj8kdLfZTH7uW56L/instances/ins_3KY8wpRSWNfSvus47xrxHGyrfSW/domains)
before changing DNS. Keep proxying off (**DNS only**) and verify DNS, TLS
certificates and email-domain verification there before release.

| Name | Target |
| --- | --- |
| `clerk.spooktober.kylescudder.co.uk` | `frontend-api.clerk.services` |
| `accounts.spooktober.kylescudder.co.uk` | `accounts.clerk.services` |
| `clkmail.spooktober.kylescudder.co.uk` | `mail.o5w90otf55dy.clerk.services` |
| `clk._domainkey.spooktober.kylescudder.co.uk` | `dkim1.o5w90otf55dy.clerk.services` |
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
python3 -B deploy/install-launchd.py
launchctl print gui/501/com.herman.spooktober-deploy
tail -n 100 state/deploy.log
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook logs --tail 50
cat state/history.log
./deploy/herman-deploy.sh sha256:<verified-main-digest>
```

The final command deploys or rolls back to an attested main image. Successful
releases persist their digest into `.env`, so a normal Compose restart keeps
the selected release. Pre-deploy JSON exports retain the most recent 14.

QueueDirectories starts the deployer when requests are present; it does not
poll GitHub. Pausing automatic requests leaves manual deployment available:

```sh
gh variable set DEPLOY_ENABLED --body false --repo kylescudder/spooktober
```

To stop the host trigger as well:

```sh
launchctl bootout gui/501/com.herman.spooktober-deploy
```

Resume the agent with the installer; existing queued requests then run. Set
`DEPLOY_ENABLED=true` only after public routing, Access and app readiness pass.

The app does not update its source checkout automatically. After reviewing and
pulling changes to `compose.yaml` or `deploy/`, recreate the receiver and rerun
the launchd installer if it changed. App releases themselves use published
images; they do not build source on Herman. Rotate the HMAC secret locally,
update the GitHub secret through private stdin, then recreate the receiver.

## Continuous integration and releases

Pull requests run [CI](../.github/workflows/ci.yml): deployment security checks,
type checks, unit tests, the production build, integration tests against disposable
PostgreSQL 18, and an unpublished production image build. CI has read-only repository
access and no secrets.

Every push to `main` runs [Release](../.github/workflows/release.yml), repeats CI,
builds native `linux/amd64` and `linux/arm64` images and publishes the multi-platform
image tagged `sha-<commit>`. It signs a provenance attestation before moving `main`
to that digest. With `DEPLOY_ENABLED=true`, the deploy job sends Herman the signed
webhook and waits for `/healthz` to report the commit in `X-Spooktober-Revision`.
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
for the app's public `/healthz` revision to match the merging commit.

Clerk's production domain CNAMEs are DNS-only and separate from the tunnel.
The runtime allows only Kyle and Rhiann's existing production user IDs.
Anonymous requests reveal no film data.

Preserve session cookies, `Authorization`, `Origin`, `X-Spooktober-Request` and
the external host/forwarded HTTPS information. Honor private/no-store caching for
HTML and `/api/trpc`; bypass Cloudflare caching for authenticated pages and API
responses. Public artwork and Next.js static assets may be cached. The app uses
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

Apply runtime grants as the owner inside `proj_spooktober`:

```sql
GRANT USAGE ON SCHEMA public TO proj_spooktober_runtime;
GRANT SELECT ON public.schema_migrations TO proj_spooktober_runtime;
REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM proj_spooktober_runtime;
GRANT SELECT, INSERT, UPDATE ON public.films TO proj_spooktober_runtime;
REVOKE DELETE ON public.films FROM proj_spooktober_runtime;
```

For an empty migrated database, keep the app stopped and choose either a seed
for a fresh list or an import from a private snapshot:

```sh
docker compose run --rm --no-deps spooktober node database.cjs seed
docker compose run --rm --no-deps -T spooktober node database.cjs import - < backups/hosted-watchlist-cutover.json
```

Seed/import refuse to overwrite populated data; invalid imports are atomic.
JSON array order defines film positions, with IDs and watched flags retained.
Timestamps normalize to UTC with nanosecond precision; unknown viewing dates
remain `null`. Existing populated PostgreSQL data can be used directly.

For a private portable JSON snapshot:

```sh
umask 077
docker compose exec -T spooktober node database.cjs export - > watchlist-backup.json
```

Check the export's exit status before using it as a backup. Restore by importing
into an empty migrated database. Local source commands use `npm run db --` with
the same `migrate`, `seed`, `import` and `export` arguments. For local PostgreSQL
and app startup, follow the [root README](../README.md#run-locally-with-docker).

## Backups and acceptance

Shared encrypted NAS backups run Sunday 03:00 Europe/London and keep one latest
successful archive at `/Volumes/kyle/Backups/herman-platform-latest.tar.gz.age`.
They contain the project PostgreSQL dump, role credentials, deployment settings,
private app secrets, deploy tooling and successful image/history records.
Use `herman-ops` and `/Users/kyle/platform/backups/operations.md` for recovery.

Back up before schema changes and test restores in a separate database, including
migration history. Keep the previous image and roll back only to a compatible
schema. Preserve the latest data before recovery; an older snapshot would discard
subsequent edits.

Verification records live under `/Users/kyle/platform/verification`. Do not
mark automatic deployment complete until a main merge's Release deploy job is
green and public health reports that same 40-character revision. Real
Kyle/Rhiann login, logout and simultaneous edits require their actual sessions;
trusted-session integration tests alone do not establish that manual acceptance.
