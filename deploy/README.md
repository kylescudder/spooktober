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
| App hostname       | `spooktober.thescudders.org`                                                   |
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
| `PUBLIC_URL`                                  | `https://spooktober.thescudders.org`                                   |
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

## Canonical hostname

Production moved to `https://spooktober.thescudders.org` on 27 October 2026.
Herman's `PUBLIC_URL` and runtime Clerk publishable key use this origin and
`clerk.spooktober.thescudders.org`. The existing Clerk production instance and
user allow-list are retained. Clerk uses the secondary application domain
configuration so its auth, account portal and email records stay scoped to
`spooktober.thescudders.org`.

The former `spooktober.kylescudder.co.uk` hostname remains registered to
`spooktober-redirect:8080`. Herman's installed Compose configuration includes a
small Caddy service using `deploy/redirect.Caddyfile` that sends permanent HTTP 308
redirects to the new origin while preserving paths and query strings. Start
that service when recovering the app's host configuration; it has no database
network or published ports. The deploy webhook keeps its existing protected URL.

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

| Name                                         | Target                              |
| -------------------------------------------- | ----------------------------------- |
| `clerk.spooktober.thescudders.org`           | `frontend-api.clerk.services`       |
| `accounts.spooktober.thescudders.org`        | `accounts.clerk.services`           |
| `clkmail.spooktober.thescudders.org`         | `mail.94amzdakfy8l.clerk.services`  |
| `clk._domainkey.spooktober.thescudders.org`  | `dkim1.94amzdakfy8l.clerk.services` |
| `clk2._domainkey.spooktober.thescudders.org` | `dkim2.94amzdakfy8l.clerk.services` |

The app needs outbound HTTPS/DNS to Clerk, and browsers must reach its Frontend
API at `https://clerk.spooktober.thescudders.org`. Set `PUBLIC_URL` to the exact
external HTTPS origin for session and write-origin checks. After changing keys or
allowed IDs, recreate the app and verify real login/logout for both people,
expired sessions and denial of an uninvited account.

## Better Auth rollout and Clerk rollback

`AUTH_PROVIDER` selects exactly one sign-in provider for the server and the
rendered pages. It defaults to `clerk`, so this release changes nothing until
it is switched. With `clerk`, every `/api/auth/*` path answers 404 and the
Clerk pages, middleware and allow-list work as before. Changing provider means
recreating the app container; the process environment is not hot-swapped.

The owner migration `0001_better_auth` only adds `auth_user`, `auth_session`,
`auth_account`, `auth_verification`, `auth_passkey`, `auth_rate_limit` and
`auth_email_limit`, and the runtime grant now covers them. Films are shared
between Kyle and Rhiann and are not keyed by user ID, so no film data changes
and no Clerk user linking is needed: access is decided by the email allow-list.

Prepare these settings in the host's protected runtime configuration, keeping
the Clerk keys and `CLERK_ALLOWED_USER_IDS` for rollback:

```dotenv
AUTH_PROVIDER=clerk
BETTER_AUTH_URL=https://spooktober.thescudders.org
BETTER_AUTH_SECRET=<stable, cryptographically random app-specific secret, 32+ characters>
BREVO_API_KEY=<Spooktober transactional API key>
AUTH_EMAIL_FROM=<verified Brevo sender on thescudders.org>
AUTH_EMAIL_DAILY_LIMIT=40
AUTH_ALLOWED_EMAILS=kyle@thescudders.org,rhiann@thescudders.org
```

These are required only when `better-auth` is selected; a missing or invalid
value then shows the setup message and refuses the film API, and error messages
name settings, never values. `BETTER_AUTH_URL` must be HTTPS in production and is
also the passkey RP ID (its hostname) and origin. Keep the secret stable across
releases and out of Git, image layers and CI.

Cutover: deploy the image through the central service (owner migrations run as
usual), confirm the Clerk site still works, then set `AUTH_PROVIDER=better-auth`
and recreate only the app service with the same image. Each person signs in once
with an email code or magic link, which creates their account; a password can
then be set from Profile. Verify sign-in for both people, an uninvited address
getting no email, the watchlist and sign-out.

Sign-in lives at `/auth/<view>` and offers four methods that link to each other:
password (`/auth/sign-in`), email code (`/auth/email-otp`), magic link
(`/auth/magic-link`) and passkey, plus `/auth/forgot-password` and
`/auth/reset-password`. They use the official Better Auth UI shadcn components,
styled with the watchlist's colours. Every method returns to the watchlist, or a
same-site `?redirectTo=` path such as `/profile`. `/auth/sign-up` redirects to
sign-in; there is no sign-up, and the Clerk `/sign-in` page redirects to
`/auth/sign-in`.

Access needs a session whose email is verified and still in
`AUTH_ALLOWED_EMAILS`, checked on every page load and tRPC call: removing an
address revokes its existing sessions' access on the next request. Accounts are
created only for allowlisted addresses. Email codes are six digits, valid once
for ten minutes with five attempts, and stored as a keyed HMAC. Magic links (10
minutes, stored hashed) and password reset links (30 minutes) are single-use.
Passwords are 12–128 characters, and a reset signs out other sessions. Mail goes
only to allowlisted addresses; everyone else gets the same success response.
Persistent limits: one email per recipient a minute and five an hour, an app-wide
budget of `AUTH_EMAIL_DAILY_LIMIT` per rolling day, and per-IP limits on every
auth endpoint (keyed on Cloudflare's `CF-Connecting-IP`). Emailed links and
redirects must stay on this site. The app forwards only the Better Auth
endpoints it uses; sign-up, account deletion, email change and email-code
password reset answer 404.

Signed-in viewers get an avatar menu with Profile and Sign out. `/profile` has a
display name, optional first and last names, the read-only verified email, set or
change password, passkeys and sign out. There are no profile photos (nowhere
private to keep them). The email-code form survives a phone switching to the mail
app: tab-scoped storage keeps only the email and request time for ten minutes,
never the code.

Emails are sent by Brevo's HTTP API (8 second timeout) with a branded layout and
`/email-logo.png`; provider responses, codes, links and keys are never logged.
Brevo's free plan adds a `List-Unsubscribe` header to transactional mail.

To roll back, set `AUTH_PROVIDER=clerk` and recreate the app service with the
same image. Keep the Clerk application, keys, DNS and allowed user IDs. Leave the
additive auth tables in place; never restore an older database to change provider.

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
python3 -B scripts/hostname.py --settings caddy/cloudflare-thescudders.json add spooktober spooktober.thescudders.org --upstream spooktober:8080
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

This gives `spooktober_runtime` read/insert/update/delete on `films`, no access to the
Drizzle migration journal (schema `drizzle`), and no schema changes.
Film removal requires this updated grant; apply it before starting this release.
The deployment hook runs it automatically, including when there are no new migrations.
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

The shared application client retires idle connections after 20 seconds and
allows 10 seconds to connect. It retains the 30-minute maximum lifetime,
10-second statement timeout, 5-second lock timeout, UTC and `public` search path.
Health uses a separate one-connection client with its own 3-second connection,
statement and response deadlines; failed probes retire it without touching the
application pool. No role-limit or installed deployment-hook changes are needed
for this policy.

CI exercises the real application and deployment clients against an eight-connection test role,
with all four application slots held open. Concurrent deployment queries must
share one backend, health must still connect, two spare slots must remain usable,
and a ninth connection must be rejected by PostgreSQL.
