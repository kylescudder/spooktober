# Pull request end-to-end check

Every pull request runs the permanent browser suite in the independent `E2E tests`
job in `.github/workflows/ci.yml`. It has no dependency on lint, typechecking or
unit-test jobs. Failures fail the check; reports and logs are retained for seven
days on success and failure. Authentication storage state is excluded from uploads.

Run locally with Bun 1.4.4:

```sh
HUSKY=0 bun install --frozen-lockfile
bunx --no-install playwright install chromium
bun run test:e2e
```

The Playwright configuration and existing harness define the application servers,
fixtures and disposable data. This check does not deploy or access production.
