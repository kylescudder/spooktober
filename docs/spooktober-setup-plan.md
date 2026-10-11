# Plan 2 — Set up Spooktober on the deployed platform

Updated 11 October 2026. Start after [Plan 1: Hermes infrastructure](hermes-infrastructure-plan.md) is complete and its `/srv/platform/handoff.md` is available.

**Result:** Kyle and Rhiann's Halloween watchlist running on the shared platform with Clerk sign-in restricted to Kyle and Rhiann, and its own PostgreSQL database. Identity is managed by Clerk; the app and film data are self-hosted. Spooktober uses **Next.js + React + TypeScript, tRPC, Zod and PostgreSQL**; the platform's Astro support is for other sites.

This plan owns this application's configuration, database, release and data cutover. Use the existing PostgreSQL, networks, Caddy, tunnel, provisioning and backup commands. Shared infrastructure remains owned by Plan 1.

## 1. Receive the platform handoff and application source

Read the completed handoff for the host architecture, exact network names, database endpoint/version, provisioning command, secret mechanism, hostname-registration commands and backup/restore procedures. Actual handoff values take precedence over examples below.

The final hostname is **spooktober.kylescudder.co.uk**. Use the existing Clerk application and private production configuration described below. Receive a committed Next.js/PostgreSQL revision from Git and build that exact source. Older source bundles and Go/SQLite deployment commands are superseded by this release. Transfer credentials and the final film-data export separately through a private channel.

The PostgreSQL implementation is in the existing `src/` application. It requires `DATABASE_URL`, uses server rendering for the initial list and typed tRPC procedures for interactive saves, and has explicit `node database.cjs migrate`, `seed`, `import` and `export` maintenance commands. Zod validates API input/output and imports. There is no SQLite fallback, automatic migration or automatic seeding during normal startup. Deployment commands are documented in [the runtime guide](deployment.md).

Release checks: `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:integration` with `TEST_DATABASE_URL` pointing to disposable PostgreSQL. The integration suite verifies migration/readiness, restricted runtime permissions, API access policy/origin behavior (with trusted session fixtures), simultaneous writes across connection pools and atomic import/export with restart persistence. Build and test the exact source received before deploying it.

## 2. Provision the app project

Use the existing platform command to create database `spooktober`, runtime login `spooktober_app` and a separate owner/migration role, or the handoff's equivalents. Register this database with the off-host backup mechanism.

Place the project under `/srv/apps/spooktober/`, keeping application source in its repository's `src/`. Build the root Dockerfile for the host architecture and record the source revision and image digest. Use the root `compose.yaml` with the platform's actual external networks. It publishes no host ports and creates no PostgreSQL service or app data volume.

Protect runtime `.env` and separate migration credentials using the platform secret mechanism. Runtime configuration is:

```text
DATABASE_URL=<private PostgreSQL URL for the runtime role>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<production instance public key>
CLERK_SECRET_KEY=<same instance private key, supplied privately>
CLERK_ALLOWED_USER_IDS=<Kyle user ID>,<Rhiann user ID>
PUBLIC_URL=https://spooktober.kylescudder.co.uk
PLATFORM_WEB_NETWORK=<actual shared web network>
PLATFORM_DB_NETWORK=<actual private database network>
```

The image listens on container port 8080. It runs one Next.js process with a 256 MiB container limit; PostgreSQL remains shared. Administrator and migration credentials do not belong in the normal app service. Migration history needs runtime `SELECT`; films need `SELECT`, `INSERT` and `UPDATE`. Follow the exact grants and commands in [deployment instructions](deployment.md).

### Clerk already provisioned

Use the existing **Spooktober** application, `app_3KY8TyyPWhWcj8kdLfZTH7uW56L`:

- Development instance: `ins_3KY8U3Is3W3o269nRbIVTDM86uT`; this checkout's private `.env` contains its keys and two allowed user IDs.
- Production instance: `ins_3KY8wpRSWNfSvus47xrxHGyrfSW`; this checkout's private `.env.clerk.production` contains its keys, two production user IDs and final `PUBLIC_URL`. This is auth configuration only: merge it with the server's database/network settings through the platform's private secret mechanism. Do not copy development `.env` to production or commit either file.
- Kyle: `kyle@thescudders.org`. Rhiann: `rhiann@thescudders.org`. Both users already exist in both instances. Use their saved instance-specific user IDs; do not create replacement accounts.
- Email-code sign-in is enabled. Passwords and social sign-in are disabled. Registration is restricted; the app additionally checks the two allowed IDs. Home is `/`, custom sign-in and after-sign-out paths are `/sign-in`.

Production DNS, certificates and email-domain verification are still pending. Add these exact **CNAME** records in the Cloudflare `kylescudder.co.uk` zone with proxying **off (DNS only)**:

| Name | Target |
|---|---|
| `clerk.spooktober.kylescudder.co.uk` | `frontend-api.clerk.services` |
| `accounts.spooktober.kylescudder.co.uk` | `accounts.clerk.services` |
| `clkmail.spooktober.kylescudder.co.uk` | `mail.o5w90otf55dy.clerk.services` |
| `clk._domainkey.spooktober.kylescudder.co.uk` | `dkim1.o5w90otf55dy.clerk.services` |
| `clk2._domainkey.spooktober.kylescudder.co.uk` | `dkim2.o5w90otf55dy.clerk.services` |

These records go directly to Clerk and are separate from the app hostname routed through the Cloudflare Tunnel. After propagation, complete and verify DNS, TLS certificates and email verification in [this production instance's Domains page](https://dashboard.clerk.com/apps/app_3KY8TyyPWhWcj8kdLfZTH7uW56L/instances/ins_3KY8wpRSWNfSvus47xrxHGyrfSW/domains). An authenticated Clerk CLI linked to this application can also check `clerk deploy status`. Do not publish the app until these checks succeed.

The app container needs outbound HTTPS/DNS to Clerk through its web network, and browsers must reach `https://clerk.spooktober.kylescudder.co.uk`. No auth container or user-table migration is needed. See [the runtime configuration guide](deployment.md#configure-clerk) for the access checks.

## 3. Test with separate data before cutover

Use a temporary hostname and separate test database through the existing provisioning/onboarding commands. Apply migrations with the migration role, apply runtime grants, and explicitly seed the sample list or import test data before starting the app. Set `PUBLIC_URL` to the exact test HTTPS origin and use a Clerk instance configured for that origin, with corresponding test-user IDs. Keep production keys/users separate from development users.

Register the Caddy route through the platform interface, using the app's unique web-network alias and port 8080:

```caddyfile
http://spooktober.kylescudder.co.uk {
    reverse_proxy spooktober:8080
}
```

Use the temporary hostname in place of the final hostname for testing. Validate/reload routes through the existing commands, preserving other sites. Ensure the proxy retains session cookies, `Authorization`, `Origin`, `X-Spooktober-Request` and the external host/HTTPS information. Honor `Cache-Control: private, no-store` on authenticated pages/API. Public artwork and Next.js static files may be cached. Remove any old Basic Auth challenges at the proxy.

Verify anonymous page redirects and API 401 responses; real Clerk login/logout for Kyle and Rhiann; expired sessions; access-denied/403 responses for a separate uninvited account; no film data when Clerk configuration or allowed IDs are missing; initial film rows present in server-rendered HTML; add, tick/untick and drag ordering; saves in a second independent browser; and failed-save retry. Cross-origin writes must fail and legitimate public-origin writes must succeed. Recreate the app and restart the test database to verify persistence and recovery. Test writes must not touch production data.

## 4. Import the real list and publish

1. Coordinate a short pause in watchlist edits. Export the hosted list at `https://spooktober.kyle978041.chatgpt.site` immediately before cutover and transfer it privately. The local ignored `data/hosted-watchlist.json` is an earlier snapshot; refresh or compare it against this final export. Retain the final JSON as a recovery artifact.
2. Keep the production app stopped while applying migrations, runtime grants and the JSON import to its empty database. Use `node database.cjs import -` for the existing list; seeding is only for a fresh start. The runtime guide provides the exact commands. Import refuses to overwrite a populated list.
3. Compare every film ID, title, array order, watched flag and timestamp with the export. Timestamps normalize to UTC while preserving their full precision; unknown viewing dates remain `null`. The final export is authoritative, even if its counts differ from the original twenty films/three watched.
4. Back up the imported PostgreSQL database through the platform command, confirm the off-host copy and restore into a separate test database. Compare the restored film data and remove only test resources.
5. Register the final hostname, set its exact `PUBLIC_URL` and production Clerk keys/user IDs, and start the production image. Check authenticated reads and imported data before directing Kyle and Rhiann to the new address for edits.
6. Verify saves between two independent sessions and persistence after app recreation. Undo intentional test edits and capture a post-cutover backup.

Keep the old hosted deployment available during acceptance. The databases do not synchronize automatically; after cutover, use the new address for edits. Retiring the hosted version is a separate follow-up.

## 5. Return the application handoff

Document the exact deployment, migration/grant, import/export, health/log and rollback commands under `/srv/apps/spooktober/`. Use the shared platform's per-project backups and recovery procedure.

Keep the previous image and record schema compatibility before image rollback. Back up before schema changes. Before new edits, a failed cutover can use the retained export and old hosted address. After new edits, preserve the latest PostgreSQL data before recovery; an old snapshot must not overwrite it.

Return the public URL, source revision, image digest, configuration locations, database/role names, secret reference locations, backup/restore evidence and application runbook. Include no secret values.

Spooktober is complete when:

- [ ] The received Next.js/PostgreSQL release passes its checks and production uses the shared database.
- [ ] Real Clerk login/logout works for Kyle and Rhiann; uninvited users and anonymous API requests are denied.
- [ ] Missing configuration and expired sessions reveal no film data; legitimate origin writes work and cross-origin writes fail.
- [ ] Add, tick/untick and ordering synchronize between two independent sessions.
- [ ] Concurrent changes retain films; app recreation and database restart preserve state.
- [ ] Imported data matches the final export, including order, dates and timestamps.
- [ ] The runtime role is restricted and the app exposes no host/public listener.
- [ ] Off-host backup and separate-database restore checks succeed.
- [ ] Release, migration, recovery and rollback commands are documented.
