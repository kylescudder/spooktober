# Deploy Spooktober — Next.js, React, tRPC and PostgreSQL

One self-hosted Node.js process runs the Next.js app, rendering the initial React list and handling typed tRPC queries/mutations. PostgreSQL comes from [Plan 1: infrastructure](hermes-infrastructure-plan.md). [Plan 2: Spooktober setup](spooktober-setup-plan.md) covers project provisioning and the real list cutover. App code lives in `src/`; production runs one unprivileged container built with Next.js standalone output.

## Configuration

Copy `.env.example` on a fresh checkout, preserving an existing private `.env`. Keep environment files mode 600 and outside source control.

| Setting | Value |
|---|---|
| `DATABASE_URL` | PostgreSQL URL for the restricted runtime login; required |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Public Clerk key from the selected instance; `pk_live_...` in production |
| `CLERK_SECRET_KEY` | Private Clerk backend key from the same instance; `sk_live_...` in production |
| `CLERK_ALLOWED_USER_IDS` | Kyle and Rhiann's exact Clerk user IDs, comma separated; at most two |
| `PUBLIC_URL` | Exact public HTTPS origin: `https://spooktober.kylescudder.co.uk` |
| `PLATFORM_WEB_NETWORK`, `PLATFORM_DB_NETWORK` | Actual external network names from the platform handoff |
| `PORT`, `HOSTNAME` | Image defaults: `8080`, `0.0.0.0` inside the private container network |

Percent-encode special characters in URL credentials. The example's `sslmode=disable` is for the private Docker database network. Use the PostgreSQL endpoint's required TLS configuration elsewhere, mounting a private CA where needed. Database credentials, `CLERK_SECRET_KEY` and the allowed user IDs remain server-only. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is deliberately public. The app reads it on the server at request time and passes it explicitly to Clerk, so all settings can be supplied at container startup. Supply no credentials as build arguments.

The production Compose file joins existing shared networks and publishes no host ports. Caddy proxies to `spooktober:8080`. PostgreSQL stores all app data. `/healthz` is an unauthenticated readiness check for database connectivity and migration history, returning 200 or 503 without film data.

## Configure Clerk

The Next.js app and PostgreSQL remain on your server; Clerk manages identity externally. No separate auth container or local user table is required.

Spooktober's application, both instances and Kyle/Rhiann accounts are already created with email-code sign-in. Use the existing keys and IDs and complete the exact production DNS records in [Plan 2](spooktober-setup-plan.md#clerk-already-provisioned). The steps below also describe how to configure a fresh environment; they are not a request to create another application or replacement users.

1. Create/select the Clerk application. Use a development instance for local testing and a production instance for the final hostname. Configure your preferred sign-in method, such as email codes. See [Clerk's production setup](https://clerk.com/docs/guides/development/deployment/production).
2. Configure the production instance's application domain and home URL for the actual HTTPS hostname. The app serves `/sign-in`; set that as the custom sign-in path and use the hosted Account Portal for account creation/invitations. Complete the Dashboard's required DNS records and certificate setup. Clerk-owned CNAMEs must be **DNS only** in Cloudflare; the film hostname still routes through your tunnel. Do not route Clerk's records to Caddy.
3. Create or invite Kyle and Rhiann through the Dashboard/Account Portal. Copy their user IDs from the selected instance into `CLERK_ALLOWED_USER_IDS`. Production IDs differ from development IDs. One user ID is accepted while setting up the second; an empty or invalid list denies all authenticated users. Sign-in alone does not grant film access.
4. Put that instance's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in protected runtime configuration. Keep the secret key out of chat, source control and build arguments. Preserve an existing private `.env`; replace the obsolete Basic Auth settings. No secret is embedded in the browser bundle.
5. Set `PUBLIC_URL` to the exact external HTTPS origin. It supplies Clerk's `authorizedParties` and the write-origin checks. With `PUBLIC_URL` empty, only the documented localhost/127.0.0.1 development origins on port 8080 are accepted. Ensure the app's web network allows outbound HTTPS/DNS to Clerk and browsers can reach Clerk's Frontend API. This integration uses Clerk's direct Frontend API rather than an app-side proxy.
6. Recreate the app after changing keys or user IDs. Test real login and logout for both people, expired sessions, and a separate uninvited account. The uninvited account must see the access-denied screen, receive 403 from the API and never receive film data. Anonymous API requests receive 401 once Clerk is configured. Missing keys or missing allowed IDs deny film access; there is no Basic Auth fallback.

The integration tests supply trusted session identities to exercise authorization and transport without contacting Clerk. Real Clerk login remains a release check requiring your configured instance. Invite-only account registration can additionally be enabled through Clerk's [access settings](https://clerk.com/docs/guides/secure/restricting-access); the application's two-user policy applies regardless of that setting.

## Build and initialize

Build from the repository root for the host architecture:

```sh
docker compose build
```

Use a separate migration/owner login in protected `.env.migration`, containing its `DATABASE_URL`. Run the same image on the private database network:

```sh
chmod 600 .env .env.migration
docker run --rm --read-only --network platform-db --env-file .env.migration spooktober:local node database.cjs migrate
```

Substitute actual platform network/image names. Migrations are numbered and repeatable. Startup never applies migrations or seeds data, so the runtime role needs no schema ownership. Have the platform provisioning mechanism or migration owner apply these grants inside the app database:

```sql
GRANT USAGE ON SCHEMA public TO spooktober_app;
GRANT SELECT ON public.schema_migrations TO spooktober_app;
REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM spooktober_app;
GRANT SELECT, INSERT, UPDATE ON public.films TO spooktober_app;
```

The platform must grant database connection access, restrict schema creation and isolate project access. Adjust grants for future migrations; migration history remains read-only at runtime.

Choose one initialization path while the app is stopped. For a fresh list:

```sh
docker compose run --rm --no-deps spooktober node database.cjs seed
```

For the existing hosted list, refresh the export immediately before cutover, transfer it privately and import instead:

```sh
docker compose run --rm --no-deps -T spooktober node database.cjs import - < data/hosted-watchlist.json
```

Both commands exit after initialization and refuse to overwrite populated data. Invalid imports are atomic. JSON array order defines positions; IDs and watched flags are retained. RFC3339 timestamps normalize to UTC while preserving up to nanoseconds; unknown viewing dates remain `null`. The existing PostgreSQL schema remains compatible with the previous Go/PostgreSQL release, so an already populated PostgreSQL database needs no JSON transfer for this framework change.

```sh
docker compose up -d
docker compose ps
docker compose logs --tail=30
```

Register the final hostname through the existing platform onboarding command. Preserve session cookies, `Authorization`, `Origin`, `X-Spooktober-Request` and the external `Host`/forwarded HTTPS information. Do not add an additional Basic Auth challenge at Caddy or Cloudflare. Honor private/no-store caching for HTML and `/api/trpc`; bypass Cloudflare caching for authenticated pages and API responses. Public artwork and Next.js static assets contain no film data and may be cached. Set the exact public `PUBLIC_URL`, then verify login and writes through HTTPS and in two independent sessions.

## Resources and operation

The supplied container is limited to 256 MiB, with Node's JavaScript heap capped at 128 MiB and four database connections. This is a limit, not a promised usage figure; measure on the target host. The filesystem is read-only with a small temporary `/tmp`. All durable state lives in PostgreSQL. Recreating this application does not delete its database.

Next.js runs SSR and tRPC in the same process. The client refreshes the shared list every 15 seconds and on focus. Runtime database failures return a retryable API error; the page keeps a loading/retry path. Maintenance uses the same image and database code, via `node database.cjs`.

## Backup, restore and updates

Use the platform's scheduled PostgreSQL dumps and off-host copies. Include migration history and test restores into a separate database.

For a private portable JSON snapshot:

```sh
umask 077
docker compose exec -T spooktober node database.cjs export - > watchlist-backup.json
```

Check the exit status before treating output as a backup. Restore with `node database.cjs import -` into an empty migrated database. Named-file exports are atomic and mode 600 when the process has a writable destination. Local source commands use `npm run db -- migrate|seed|import|export`.

Before updates, back up the database and keep the previous image. Apply migrations with the owner role and update grants before deploying. Roll back only to an image compatible with the schema. Preserve the latest data before recovery; restoring an old snapshot after new edits would discard those edits.

## Continuous integration and releases

Pull requests run `.github/workflows/ci.yml`: type checks, unit tests, the production build, integration tests against a disposable PostgreSQL 18 service, and an unpublished build of the production image. It has read-only repository access and no secrets.

Every push to `main` runs `.github/workflows/release.yml`. It repeats those checks, builds native `linux/amd64` and `linux/arm64` images from the root Dockerfile and publishes a multi-platform image to `ghcr.io/kylescudder/spooktober` tagged `sha-<commit>`. It signs a build provenance attestation for that digest, then moves the `main` tag to it. When the `DEPLOY_ENABLED` repository variable is `true`, a final `deploy` job asks Herman to deploy that digest through a signed webhook and waits until `/healthz` reports the new commit in its `X-Spooktober-Revision` header; see the [Herman operating guide](../deploy/README.md). Protect `main` with required pull requests and a passing `CI / check`, since every merge publishes an image.

Verify an image before running it:

```sh
gh attestation verify oci://ghcr.io/kylescudder/spooktober@sha256:<digest> --bundle-from-oci \
  --repo kylescudder/spooktober \
  --signer-workflow kylescudder/spooktober/.github/workflows/release.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

To run a published image instead of a local build, set `SPOOKTOBER_IMAGE` to its exact digest, for example `SPOOKTOBER_IMAGE=ghcr.io/kylescudder/spooktober@sha256:<digest> docker compose up -d --no-build`. Without it, Compose uses `spooktober:local`. The package must be public, or the host logged in to `ghcr.io` with a `read:packages` token.

## Local development

`compose.dev.yaml` runs the same app with its own PostgreSQL 18 service, development-only login and loopback ports. Follow the [README](../README.md) for Docker or Node.js development. No service or binary is installed on the host by these files. The production platform remains separate from local development.
