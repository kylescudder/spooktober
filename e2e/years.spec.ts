import { expect, test } from '@playwright/test'

const base = `http://127.0.0.1:${Number(process.env.E2E_PORT || 8080) + 3}`
test.skip(
  !process.env.E2E_WATCHLIST_DATABASE_URL,
  'Requires a disposable PostgreSQL control database; Clerk is replaced at the existing trusted-session seam.'
)

test('defaults follow the current year; selecting a year survives reload and browser navigation', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2031 : 2131
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.setFixedTime(new Date(`${year}-10-24T12:00:00Z`))
  await page.goto(base)
  const picker = page.getByRole('combobox', { name: 'Watchlist year' })
  await expect(picker).toHaveValue(String(year))
  await expect(
    page.getByRole('heading', { name: `Our ${year} line-up` })
  ).toBeVisible()
  await picker.selectOption(String(year - 1))
  await expect(page).toHaveURL(`${base}/?year=${year - 1}`)
  await expect(picker).toHaveValue(String(year - 1))
  await page.reload()
  await expect(picker).toHaveValue(String(year - 1))
  await page.goBack()
  await expect(picker).toHaveValue(String(year))
  await page.goForward()
  await expect(picker).toHaveValue(String(year - 1))
  await page.goto(`${base}/?year=invalid`)
  await expect(picker).toHaveValue(String(year))
  await page.clock.setFixedTime(new Date(`${year + 1}-01-01T12:00:00Z`))
  await page.goto(base)
  await expect(picker).toHaveValue(String(year + 1))
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
})

test('films, progress and keyboard reordering remain in their selected year after reload', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2051 : 2151
  await page.clock.setFixedTime(new Date(`${year}-10-24T12:00:00Z`))
  await page.goto(base)
  const picker = page.getByRole('combobox', { name: 'Watchlist year' })
  async function add(title: string) {
    await page.getByRole('button', { name: 'Add film', exact: true }).click()
    await page.getByRole('textbox', { name: 'Film title' }).fill(title)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Add film', exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await add('The Thing')
  await add('Alien')
  await page
    .getByRole('checkbox', { name: 'Mark The Thing as watched', exact: true })
    .click()
  await expect(
    page.getByRole('checkbox', { name: 'Mark The Thing as unwatched' })
  ).toBeEnabled()
  const targetId = await page
    .locator('.film-row')
    .first()
    .getAttribute('data-film-id')
  await page.getByRole('button', { name: 'Reorder Alien', exact: true }).focus()
  // The keyboard sensor attaches its movement listener on the next task.
  // A normal key dwell lets activation finish before the movement key.
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.film-row.is-dragging')).toContainText('Alien')
  const activeId = await page
    .locator('.film-row.is-dragging')
    .getAttribute('data-film-id')
  await expect(page.locator('[id^="DndLiveRegion-"]')).toContainText(
    `was moved over droppable area ${activeId}.`
  )
  await page.keyboard.press('ArrowUp', { delay: 100 })
  await expect(page.locator('[id^="DndLiveRegion-"]')).toContainText(
    `was moved over droppable area ${targetId}.`
  )
  await page.keyboard.press('Space')
  await expect(page.locator('.film-row').first()).toContainText('Alien')
  await expect(picker).toBeEnabled()
  await picker.selectOption(String(year - 1))
  await expect(page.getByText('Our first fright is waiting.')).toBeVisible()
  await expect(page.locator('.progress-copy')).toContainText(
    '0 of 0 films watched'
  )
  await add('Halloween')
  await picker.selectOption(String(year))
  await expect(page.locator('.film-row')).toHaveCount(2)
  await page.reload()
  await expect(page.locator('.film-row').first()).toContainText('Alien')
  await expect(
    page.getByRole('checkbox', { name: 'Mark The Thing as unwatched' })
  ).toBeChecked()
  await expect(page.locator('.progress-copy')).toContainText(
    '1 of 2 films watched'
  )
  await expect(page.getByText('Halloween', { exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: `artifacts/year-picker/${info.project.name}-annual-list.png`,
    fullPage: true
  })
})

test('a failed save can be retried in the selected year without contaminating another year', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2071 : 2171
  await page.clock.setFixedTime(new Date(`${year}-10-24T12:00:00Z`))
  await page.goto(`${base}/?year=${year - 1}`)
  await page.getByRole('button', { name: 'Add film', exact: true }).click()
  await page.getByRole('textbox', { name: 'Film title' }).fill('Suspiria')
  await page.route('**/api/trpc/films.add*', (route) => route.abort(), {
    times: 1
  })
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add film', exact: true })
    .click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'temporarily unavailable'
  )
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.film-row')).toHaveCount(1)
  await expect(page.locator('.save-status')).toHaveText('Saved for both of us')
  await page.reload()
  await expect(page.getByText('Suspiria', { exact: true })).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Watchlist year' })
    .selectOption(String(year))
  await expect(page.getByText('Our first fright is waiting.')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
