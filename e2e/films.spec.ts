import { expect, test, type Page } from '@playwright/test'

const base = `http://127.0.0.1:${Number(process.env.E2E_PORT || 8080) + 3}`
test.skip(
  !process.env.E2E_WATCHLIST_DATABASE_URL,
  'Requires a disposable PostgreSQL control database; Clerk is replaced at the existing trusted-session seam.'
)

async function add(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add film', exact: true }).click()
  await page.getByRole('textbox', { name: 'Film title' }).fill(title)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add film', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function action(
  page: Page,
  title: string,
  name: 'Edit title' | 'Remove film'
) {
  await page
    .getByRole('button', { name: `Actions for ${title}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

test('editing preserves progress and order; confirmed removal persists only in the selected year', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2081 : 2181
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/?year=${year - 1}`)
  await add(page, 'Previous season')
  await page.goto(`${base}/?year=${year}`)
  await add(page, 'The Thing')
  await add(page, 'Alien')
  await page
    .getByRole('checkbox', { name: 'Mark The Thing as watched', exact: true })
    .click()
  await expect(
    page.getByRole('checkbox', { name: 'Mark The Thing as unwatched' })
  ).toBeEnabled()

  await action(page, 'The Thing', 'Edit title')
  const title = page.getByRole('textbox', { name: 'Film title' })
  await expect(title).toHaveValue('The Thing')
  await title.fill('Cancelled title')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.film-row').first()).toContainText('The Thing')
  await action(page, 'The Thing', 'Edit title')
  await title.fill('   ')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(title).toHaveAttribute('aria-invalid', 'true')
  await expect(
    page.getByText('Enter a film title between 1 and 200 characters.', {
      exact: true
    })
  ).toBeVisible()
  await title.fill(' The Thing (1982) ')
  await page.screenshot({
    path: `artifacts/film-management/${info.project.name}-edit.png`,
    animations: 'disabled',
    fullPage: true
  })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.film-row').first()).toContainText(
    'The Thing (1982)'
  )
  await expect(
    page.getByRole('checkbox', { name: 'Mark The Thing (1982) as unwatched' })
  ).toBeChecked()
  await expect(page.locator('.progress-copy')).toContainText(
    '1 of 2 films watched'
  )

  await action(page, 'The Thing (1982)', 'Remove film')
  await expect(page.getByRole('dialog')).toContainText('The Thing (1982)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.film-row')).toHaveCount(2)
  await action(page, 'The Thing (1982)', 'Remove film')
  await page.screenshot({
    path: `artifacts/film-management/${info.project.name}-remove.png`,
    animations: 'disabled',
    fullPage: true
  })
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove film', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.progress-copy')).toContainText(
    '0 of 1 films watched'
  )
  await page.reload()
  await expect(page.locator('.film-row')).toHaveCount(1)
  await expect(page.locator('.film-row').first()).toContainText('Alien')
  await expect(page.locator('.film-number').first()).toHaveText('01')
  await expect(page.locator('.next-label')).toHaveText('Up next')
  await page.screenshot({
    path: `artifacts/film-management/${info.project.name}-list.png`,
    animations: 'disabled',
    fullPage: true
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await action(page, 'Alien', 'Remove film')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove film', exact: true })
    .click()
  await expect(page.getByText('Our first fright is waiting.')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.progress-copy')).toContainText(
    '0 of 0 films watched'
  )
  await page.goto(`${base}/?year=${year - 1}`)
  await expect(page.locator('.film-row')).toHaveCount(1)
  await expect(page.locator('.film-row')).toContainText('Previous season')
  expect(errors).toEqual([])
})

test('failed edits retain the draft and can be retried without losing watched status', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2082 : 2182
  await page.goto(`${base}/?year=${year}`)
  await add(page, 'Suspiria')
  await action(page, 'Suspiria', 'Edit title')
  await page
    .getByRole('textbox', { name: 'Film title' })
    .fill('Suspiria (1977)')
  await page.route('**/api/trpc/films.edit*', (route) => route.abort(), {
    times: 1
  })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'temporarily unavailable'
  )
  await expect(page.getByRole('textbox', { name: 'Film title' })).toHaveValue(
    'Suspiria (1977)'
  )
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Retry', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.film-row')).toContainText('Suspiria (1977)')
  await expect(
    page.getByRole('checkbox', { name: 'Mark Suspiria (1977) as watched' })
  ).not.toBeChecked()
})

test('removal rolls back on failure and retry succeeds even after the server committed', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2083 : 2183
  await page.goto(`${base}/?year=${year}`)
  await add(page, 'Halloween')
  await add(page, 'Alien')
  await action(page, 'Halloween', 'Remove film')
  await page.route('**/api/trpc/films.remove*', (route) => route.abort(), {
    times: 1
  })
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove film', exact: true })
    .click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'temporarily unavailable'
  )
  await expect(page.locator('.film-row')).toHaveCount(2)
  // Lose the retry's response after PostgreSQL commits the removal.
  await page.route(
    '**/api/trpc/films.remove*',
    async (route) => {
      await route.fetch()
      await route.abort()
    },
    { times: 1 }
  )
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Retry', exact: true })
    .click()
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Retry', exact: true })
  ).toBeEnabled()
  await expect(page.locator('.film-row')).toHaveCount(2)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Retry', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.film-row')).toHaveCount(1)
  await expect(page.locator('.film-row')).toContainText('Alien')
})

test('keyboard actions support editing, cancellation and adding afterwards; long titles fit', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2084 : 2184
  await page.goto(`${base}/?year=${year}`)
  await add(page, 'Candyman')
  const trigger = page.getByRole('button', {
    name: 'Actions for Candyman',
    exact: true
  })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('menuitem', { name: 'Edit title', exact: true })
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Film title' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await add(page, 'Alien')
  await expect(page.locator('.film-row')).toHaveCount(2)
  await expect(page.locator('.film-row').first()).toContainText('Candyman')
  await action(page, 'Candyman', 'Edit title')
  const longTitle = 'A'.repeat(200)
  await page.getByRole('textbox', { name: 'Film title' }).fill(longTitle)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await action(page, longTitle, 'Remove film')
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeFocused()
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeInViewport()
  expect(
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)
  ).toBe(true)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('a failed removal is offered only in the confirmation for the same film', async ({
  page
}, info) => {
  const year = info.project.name === 'desktop' ? 2085 : 2185
  await page.goto(`${base}/?year=${year}`)
  await add(page, 'Halloween')
  await add(page, 'Alien')
  await action(page, 'Halloween', 'Remove film')
  await page.route('**/api/trpc/films.remove*', (route) => route.abort(), {
    times: 1
  })
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Remove film', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    'temporarily unavailable'
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await action(page, 'Alien', 'Remove film')
  await expect(dialog).toContainText('Remove “Alien”')
  await expect(
    dialog.getByRole('button', { name: 'Retry', exact: true })
  ).toHaveCount(0)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(
    dialog.getByRole('button', { name: 'Remove film', exact: true })
  ).toBeEnabled()
  await page.screenshot({
    path: `artifacts/film-retry-feedback/${info.project.name}-confirm-alien.png`,
    animations: 'disabled',
    fullPage: true
  })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // Cancelling a different confirmation preserves the original, correctly scoped retry.
  await action(page, 'Halloween', 'Remove film')
  await expect(
    dialog.getByRole('button', { name: 'Retry', exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await action(page, 'Alien', 'Remove film')
  await dialog.getByRole('button', { name: 'Remove film', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.film-row')).toHaveCount(1)
  await expect(page.locator('.film-row')).toContainText('Halloween')
})

for (const [index, scenario] of [
  { failed: 'remove', target: 'edit same film' },
  { failed: 'edit', target: 'edit another film' },
  { failed: 'edit', target: 'add a film' }
].entries()) {
  test(`a failed ${scenario.failed} cannot be retried from ${scenario.target}`, async ({
    page
  }, info) => {
    const year = (info.project.name === 'desktop' ? 2086 : 2186) + index
    await page.goto(`${base}/?year=${year}`)
    await add(page, 'Halloween')
    await add(page, 'Alien')
    await action(
      page,
      'Halloween',
      scenario.failed === 'edit' ? 'Edit title' : 'Remove film'
    )
    const dialog = page.getByRole('dialog')
    if (scenario.failed === 'edit')
      await page
        .getByRole('textbox', { name: 'Film title' })
        .fill('Halloween (1978)')
    await page.route(
      `**/api/trpc/films.${scenario.failed}*`,
      (route) => route.abort(),
      { times: 1 }
    )
    await dialog
      .getByRole('button', {
        name: scenario.failed === 'edit' ? 'Save changes' : 'Remove film',
        exact: true
      })
      .click()
    await expect(dialog.getByRole('alert')).toContainText(
      'temporarily unavailable'
    )
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const adding = scenario.target === 'add a film'
    if (adding)
      await page.getByRole('button', { name: 'Add film', exact: true }).click()
    else
      await action(
        page,
        scenario.target === 'edit same film' ? 'Halloween' : 'Alien',
        'Edit title'
      )
    await expect(
      dialog.getByRole('button', { name: 'Retry', exact: true })
    ).toHaveCount(0)
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    const submit = dialog.getByRole('button', {
      name: adding ? 'Add film' : 'Save changes',
      exact: true
    })
    await expect(submit).toBeEnabled()
    await page.getByRole('textbox', { name: 'Film title' }).fill('The Thing')
    await submit.click()
    await expect(dialog).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.film-row')).toHaveCount(adding ? 3 : 2)
    const expected =
      scenario.target === 'edit same film'
        ? ['The Thing', 'Alien']
        : adding
          ? ['Halloween', 'Alien', 'The Thing']
          : ['Halloween', 'The Thing']
    await expect(page.locator('.film-title')).toHaveText(expected)
  })
}
