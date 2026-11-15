import { defineConfig } from '@playwright/test'
export default defineConfig({
  globalSetup: './e2e/setup.ts',
  testDir: './e2e',
  testMatch: '**/*.auth.ts',
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'state/e2e/playwright-report', open: 'never' }]
  ],
  outputDir: 'state/e2e/test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL,
    storageState: 'state/e2e/auth.json',
    trace: 'off',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } }
  ],
  webServer: {
    command: 'bun run start',
    url: process.env.E2E_BASE_URL!,
    reuseExistingServer: false
  }
})
