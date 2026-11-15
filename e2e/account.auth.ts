import { expect, test } from '@playwright/test'
test('a signed-in profile remains available after reload', async ({ page }) => {
  await page.goto('/profile')
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true })
  ).toBeVisible()
})
test('a signed-out visitor must sign in to open their profile', async ({
  browser
}) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] }
  })
  try {
    const page = await context.newPage()
    await page.goto(process.env.E2E_BASE_URL + '/profile')
    await expect(page).toHaveURL(/\/auth\/sign-in/)
    await expect(page.locator('#password')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('a signed-in film can be added and marked watched after reload', async ({
  page
}, info) => {
  await page.goto('/')
  const title = `A browser film ${info.project.name}`
  await page.getByRole('button', { name: 'Add film', exact: true }).click()
  await page.getByRole('textbox', { name: 'Film title' }).fill(title)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add film', exact: true })
    .click()
  const watched = page.getByRole('checkbox', {
    name: `Mark ${title} as watched`,
    exact: true
  })
  await expect(watched).toBeVisible()
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('films.setWatched') &&
      response.request().method() === 'POST'
  )
  await watched.click()
  expect((await saved).ok()).toBe(true)
  await expect(
    page.getByRole('checkbox', {
      name: `Mark ${title} as unwatched`,
      exact: true
    })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('checkbox', {
      name: `Mark ${title} as unwatched`,
      exact: true
    })
  ).toBeVisible()
  await page.screenshot({
    path: info.outputPath('watchlist.png'),
    fullPage: true
  })
})
