import { chromium, expect, type FullConfig } from '@playwright/test'
import { mkdir, chmod } from 'node:fs/promises'
export default async function setup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!
  if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname))
    throw new Error('Local e2e server required')
  if (!process.env.E2E_USERNAME || !process.env.E2E_PASSWORD)
    throw new Error('Run bun run test:e2e to provision a test account')
  await mkdir('state/e2e', { recursive: true })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(baseURL + '/auth/sign-in?redirectTo=%2Fprofile')
    await page.locator('#email').fill(process.env.E2E_USERNAME)
    await page.locator('#password').fill(process.env.E2E_PASSWORD)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/'))
    await page.goto(baseURL + '/profile')
    await expect(
      page.getByRole('button', { name: 'Sign out', exact: true })
    ).toBeVisible()
    await page.context().storageState({ path: 'state/e2e/auth.json' })
    await chmod('state/e2e/auth.json', 0o600)
  } finally {
    await browser.close()
  }
}
