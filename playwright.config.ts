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
        AUTH_ALLOWED_EMAILS: '',
        DATABASE_URL:
          process.env.E2E_DATABASE_URL ||
          'postgres://unavailable@127.0.0.1:1/spooktober_test'
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
