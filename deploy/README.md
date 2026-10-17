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
| Database | `spooktober`, private `postgres:5432` on internal `platform-db` |
| Database roles | `spooktober_owner` for migrations, `spooktober_runtime` for the app |
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

## Backups and acceptance

Shared encrypted NAS backups run Sunday 03:00 Europe/London and keep one latest
successful archive at `/Volumes/kyle/Backups/herman-platform-latest.tar.gz.age`.
They contain the project PostgreSQL dump, role credentials, deployment settings,
private app secrets, deploy tooling and successful image/history records.
Use `herman-ops` and `/Users/kyle/platform/backups/operations.md` for recovery.

Verification records live under `/Users/kyle/platform/verification`. Do not
mark automatic deployment complete until a main merge's Release deploy job is
green and public health reports that same 40-character revision. Real
Kyle/Rhiann login, logout and simultaneous edits require their actual sessions;
trusted-session integration tests alone do not establish that manual acceptance.
