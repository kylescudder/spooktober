# Plan 2 — Set up Spooktober on the deployed platform

Prepared 5 October 2026. Start after [Plan 1: Hermes infrastructure](hermes-infrastructure-plan.md) is complete and its `/srv/platform/handoff.md` is available.

**Result:** Kyle and Rhiann's existing Halloween watchlist running on the shared platform, protected by Basic Auth, with film order and watched status stored in its own PostgreSQL database.

This plan owns Spooktober's application changes, configuration, database, release and data cutover. Use the already deployed PostgreSQL, networks, Caddy, tunnel, provisioning commands and backup system. Any missing shared capability is a gap in Plan 1 to resolve through its runbook, rather than creating duplicate infrastructure.

## 1. Check prerequisites and current app status

Read the completed infrastructure handoff for the host architecture, network names, database endpoint/version, project-provisioning command, migration grants, secret mechanism, container template, hostname-registration command and backup/restore procedures. Actual handoff values take precedence over examples in this plan.

Obtain the chosen Spooktober hostname and Basic Auth credentials. `films.example.com` below is a placeholder. Receive the application source as a complete commit or the sanitized `artifacts/spooktober-source-for-hermes.tar.gz` bundle and its checksum. The implementation is currently uncommitted locally, so a fresh remote clone may only contain the initial commit. Credentials and film-data exports are supplied separately through a private channel.

Current status:

- One application lives in `src/`: a Go HTTP server with an embedded React interface, seed and migrations. Build configuration lives at the repository root. Keep this single source layout.
- The current app uses **SQLite**. It supports Basic Auth, adding films, watched flags, draggable ordering, polling, JSON export/import and persistent saves.
- **PostgreSQL support is not implemented.** The current executable does not read `DATABASE_URL`. Complete section 2 before attempting a production deployment on this platform.
- The SQLite build has passed frontend type checks/tests/build, Go API/authentication/concurrency/persistence tests, container restart checks and browser checks on desktop and mobile. PostgreSQL and this server deployment have not been verified.
- The earlier hosted list remains at `https://spooktober.kyle978041.chatgpt.site` for export and cutover. Its archived source is outside the active repository; do not recreate a parallel application directory.

The bundled source excludes credentials, film-data snapshots, generated assets, installed dependencies and hosting metadata. The [existing runtime guide](deployment.md) describes the current SQLite build; revise it as part of the PostgreSQL change below.

## 2. Implement and verify PostgreSQL storage

Retain the Go server, React interface and existing API behavior. Change storage within `src/`; an Astro or Node rewrite is not required for this app.

1. Add a PostgreSQL driver such as `pgx` through `database/sql`, and require `DATABASE_URL` for the production build. Missing or invalid PostgreSQL configuration must fail clearly. Use PostgreSQL as this app's storage going forward; remove the old automatic SQLite path and its deployment configuration.
2. Add versioned PostgreSQL migrations. Preserve film IDs as text because seeded IDs such as `film-01` are not UUIDs. Preserve title, position, watched flag, nullable viewing date, creation time and update time, with UTC timestamps and the browser's existing camelCase JSON fields. Order deterministically by position and ID.
3. Replace SQLite placeholders and `PRAGMA` operations. Preserve idempotent add retries, independent watched/order updates, unknown viewing dates as `null`, and stale reorders that retain films added by another viewer.
4. Serialize list mutations inside PostgreSQL transactions using a consistent transaction-level lock, including position allocation and reorder. The current single SQLite connection serializes operations; PostgreSQL pooling alone does not provide that guarantee. Test concurrent adds/reorders through separate connections.
5. Provide explicit one-shot migration and JSON import/export commands. Run migrations with the migration role and normal requests with the runtime role. Import atomically into an empty database and refuse to overwrite a populated list. Apply the platform's runtime grants after migrations. Seed the original twenty films only for an intentional fresh start; never seed over imported data or reset the list during startup.
6. Preserve Basic Auth on the page, assets and film APIs, and same-origin JSON write protection. Configure the exact public HTTPS origin through `PUBLIC_URL`. Readiness must check PostgreSQL connectivity and schema readiness, and the app must recover from temporary database interruptions.
7. Update the root `Dockerfile`, `compose.yaml`, `.env.example`, `go.mod`, tests and runtime guide for PostgreSQL. Remove SQLite-specific toolchain, flags and data-volume assumptions where no longer needed. Keep the UI embedded in one Go executable, an unprivileged container user and a read-only root filesystem where practical. Use a small bounded connection pool consistent with the platform budget.

Run frontend type checks, validation tests and the production build, plus storage/API tests against disposable PostgreSQL. Verify authentication, cross-origin rejection, import/export, restart persistence, concurrent writes, role grants and recovery after database interruption. Build for the host's architecture and record the source revision or bundle checksum and image digest.

**Gate:** production setup begins only after this PostgreSQL build and its real-database checks pass. Do not deploy the existing SQLite image with a new environment variable and call it migrated.

## 3. Provision this project using the platform

Use the Plan 1 provisioning command to create database `spooktober`, runtime login `spooktober_app` and its separate owner/migration role, or the platform's documented equivalents. Register the database with the existing backup mechanism. Store credentials using the platform secret mechanism; administrator and migration credentials stay out of the normal app service.

Use the generic container template under `/srv/platform/templates/` to create the project under `/srv/apps/spooktober/`. Join the actual shared web/database networks, assign a unique upstream alias, publish no host port and retain versioned release metadata. Set restart policy, health check and bounded logs. Measure usage before setting the final resource limit; previous SQLite measurements do not establish the PostgreSQL app's usage.

The configuration contract after section 2 is:

```text
ADDR=:8080
DATABASE_URL=<private connection string using the runtime role>
BASIC_AUTH_USERNAME=spooktober
BASIC_AUTH_PASSWORD=<supplied privately>
PUBLIC_URL=https://films.example.com
```

Use the actual username and hostname supplied by Kyle. Keep any environment file ignored and mode 600, or use supported file-based secrets. Deliver the exact migration/import/export commands with the new implementation; current SQLite CLI examples must not be presented as PostgreSQL commands without verification.

## 4. Verify a test deployment before cutover

Use a temporary hostname and a separate test database through the existing onboarding commands. Test writes must not touch the production list. Register the Caddy route using the app's unique alias and port 8080; the expected route is:

```caddyfile
http://films.example.com {
    reverse_proxy spooktober:8080
}
```

The example assumes that alias was assigned on the shared web network. Use the platform's route-registration interface to validate/reload Caddy and register Cloudflare DNS/tunnel routing, preserving other sites.

Set `PUBLIC_URL` to the actual test HTTPS origin. Verify that the proxy retains `Authorization`, `Origin` and `X-Spooktober-Request`. Ensure Cloudflare honors `Cache-Control: private, no-store` for the app and has no cache-everything rule on its hostname.

Check anonymous and wrong-password challenges for the page/assets/API, valid login, adding films, tick/untick, drag ordering, independent browser sessions and failed-save retry. Verify legitimate public-origin writes succeed and cross-origin writes fail. Recreate the container and confirm state remains; test temporary database unavailability and recovery. Record results before moving on.

## 5. Import the real list and switch the address

1. Coordinate a short pause in watchlist edits. Export the hosted list immediately before cutover and transfer it privately. Kyle's ignored `data/hosted-watchlist.json` is an earlier snapshot and must be refreshed or checked against that final export. Retain the final JSON as a recovery artifact.
2. Keep the normal production app stopped while running migrations and import into the empty production database with appropriate credentials. Do not start it with automatic seeding beforehand. Compare every ID, title, position, watched flag and timestamp against the export, including unknown viewing dates. The last known count was twenty films with three watched; the final export is authoritative.
3. Take a production database dump through the platform backup command, confirm its off-host copy, and restore it into a separate test database. Compare restored film data and clean up only the test database.
4. Register the final hostname through the platform, set the exact final `PUBLIC_URL`, and start the production image. Check authenticated read-only access and imported data first, then direct Kyle and Rhiann to the new address for edits.
5. Verify saves synchronize between two independent browser sessions and survive container recreation. Restore any intentional test edits to their original values and capture a post-cutover backup.

Keep the old hosted deployment available for reference during acceptance. Once edits begin on the new site, its database is authoritative; the old hosted list does not synchronize automatically. Retiring the old deployment is a later follow-up.

## 6. Recovery and application handoff

Use the shared platform's backup and restore commands for this project's database. Document the app's exact deploy, migration, import/export, log, health and rollback commands under `/srv/apps/spooktober/`, and update the repository runtime guide to match the PostgreSQL release.

Keep the previous image and record schema compatibility before an image rollback. Take a backup before schema changes. For a failed cutover before new edits, use the retained export and old hosted address. After the new site accepts edits, preserve its latest data before recovery; do not overwrite it with the old snapshot. Restores involving schema rollback must follow the platform runbook and the application's compatibility notes.

Return the public URL, source revision or source-bundle checksum, deployed image digest, project configuration locations, database/role names, secret reference locations, backup/restore evidence and application runbook. Never include secret values.

Spooktober is complete when:

- [ ] The PostgreSQL build passes real-database tests and production uses the shared database.
- [ ] Basic Auth protects the page/assets/API; authenticated public-origin writes succeed and cross-origin writes fail.
- [ ] Add, tick/untick and drag ordering save and appear in a second independent session.
- [ ] Concurrent changes preserve all films; recreation and database interruption do not lose state.
- [ ] Imported data matches the final export, including ordering, dates and timestamps.
- [ ] The app has no unintended host/public listener and uses its restricted runtime login.
- [ ] Its off-host backup succeeds and a separate-database restore matches the data.
- [ ] Release, migration, recovery and rollback commands are documented without changing shared infrastructure ownership.
