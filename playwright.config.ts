import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT || 8080)

export default defineConfig({
  testDir: './e2e',
  outputDir: 'artifacts/tanstack-migration/test-results',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: 'artifacts/tanstack-migration/playwright-report',
        open: 'never'
      }
    ]
  ],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' }
    }
  ],
  webServer: [
    {
      command: 'bun run start',
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
      env: {
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_URL: '',
        CLERK_PUBLISHABLE_KEY: '',
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
        VITE_CLERK_PUBLISHABLE_KEY: '',
        CLERK_SECRET_KEY: '',
        DATABASE_URL:
          process.env.E2E_DATABASE_URL ||
          'postgres://unavailable@127.0.0.1:1/spooktober_test'
      }
    },
    {
      command: 'bun run start',
      url: `http://127.0.0.1:${port + 2}/sign-in`,
      reuseExistingServer: false,
      // Public, deliberately nonfunctional fixture keys exercise Clerk's real
      // signed-out middleware. They cannot authenticate a user or call Clerk APIs.
      env: {
        HOST: '127.0.0.1',
        PORT: String(port + 2),
        PUBLIC_URL: `http://127.0.0.1:${port + 2}`,
        CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
        CLERK_SECRET_KEY: 'sk_test_fixture',
        CLERK_ALLOWED_USER_IDS: 'user_Kyle,user_Rhiann',
        CLERK_TELEMETRY_DISABLED: 'true',
        DATABASE_URL: 'postgres://unavailable@127.0.0.1:1/spooktober_test'
      }
    },
    {
      // A separate, test-only host for the production watchlist route. There is
      // no authentication bypass or fixture route in the application build.
      command:
        'bunx --no-install vite --config e2e/fixtures/watchlist/vite.config.ts',
      url: `http://127.0.0.1:${port + 3}`,
      reuseExistingServer: false
    }
  ]
})
