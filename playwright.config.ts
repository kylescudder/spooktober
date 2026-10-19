import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "artifacts/tanstack-migration/test-results",
  reporter: [["list"], ["html", { outputFolder: "artifacts/tanstack-migration/playwright-report", open: "never" }]],
  use: { baseURL: "http://127.0.0.1:8080", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: [{
    command: "bun run start",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: false,
    env: {
      HOST: "127.0.0.1", PORT: "8080", PUBLIC_URL: "",
      CLERK_PUBLISHABLE_KEY: "", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "", VITE_CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "",
      DATABASE_URL: process.env.E2E_DATABASE_URL || "postgres://unavailable@127.0.0.1:1/spooktober_test",
    },
  }, {
    command: "bun run start",
    url: "http://127.0.0.1:8082/sign-in",
    reuseExistingServer: false,
    // Public, deliberately nonfunctional fixture keys exercise Clerk's real
    // signed-out middleware. They cannot authenticate a user or call Clerk APIs.
    env: {
      HOST: "127.0.0.1", PORT: "8082", PUBLIC_URL: "http://127.0.0.1:8082",
      CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: "sk_test_fixture", CLERK_ALLOWED_USER_IDS: "user_Kyle,user_Rhiann",
      CLERK_TELEMETRY_DISABLED: "true",
      DATABASE_URL: "postgres://unavailable@127.0.0.1:1/spooktober_test",
    },
  }],
});
