import { expect, test } from '@playwright/test'

test('setup pages render and hydrate without exposing the private watchlist', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const path of [
    '/',
    '/sign-in',
    '/sign-in/verify-email-address',
    '/access-denied'
  ]) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    expect(response?.headers()['cache-control']).toBe('private, no-store')
    await expect(
      page.getByRole('heading', { name: 'Our film nights are almost ready.' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add film' })).toHaveCount(0)
    await expect(page).toHaveTitle('Spooktober · Kyle & Rhiann')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow'
    )
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  }
  expect(errors).toEqual([])
})

test('unknown pages return 404 and client navigation returns to the watchlist', async ({
  page
}) => {
  const response = await page.goto('/missing-page')
  expect(response?.status()).toBe(404)
  await expect(
    page.getByRole('heading', { name: 'This page has wandered off.' })
  ).toBeVisible()
  await page.getByRole('link', { name: 'Back to our film nights' }).click()
  await expect(page).toHaveURL('/')
  await expect(
    page.getByRole('heading', { name: 'Our film nights are almost ready.' })
  ).toBeVisible()
})

test('film endpoints fail closed without configured Clerk keys', async ({
  request
}) => {
  for (const method of ['GET', 'POST']) {
    const response = await request.fetch(
      `/api/trpc/films.${method === 'GET' ? 'list' : 'add'}`,
      {
        method,
        ...(method === 'POST'
          ? { data: { title: 'Should never be saved' } }
          : {})
      }
    )
    expect(response.status()).toBe(503)
    expect(response.headers()['cache-control']).toBe('private, no-store')
    expect(await response.json()).toEqual({
      error: 'Sign-in is still being set up. Please try again later.'
    })
  }
})

test('readiness reports database health without revealing films', async ({
  request
}) => {
  const response = await request.get('/healthz')
  if (process.env.E2E_DATABASE_URL) {
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      revision: expect.any(String)
    })
    expect(response.headers()['x-spooktober-revision']).toBeTruthy()
  } else {
    expect(response.status()).toBe(503)
    expect(await response.json()).toEqual({ ok: false })
  }
  expect(response.headers()['cache-control']).toBe('private, no-store')
})

test('Clerk middleware redirects signed-out pages and denies film reads and writes', async ({
  request
}) => {
  for (const path of ['/', '/access-denied']) {
    const response = await request.get(
      `http://127.0.0.1:${Number(process.env.E2E_PORT || 8080) + 2}${path}`,
      { maxRedirects: 0 }
    )
    expect(response.status()).toBe(307)
    expect(response.headers().location).toBe('/sign-in')
    expect(response.headers()['cache-control']).toBe('private, no-store')
  }
  for (const method of ['GET', 'POST']) {
    const response = await request.fetch(
      `http://127.0.0.1:${Number(process.env.E2E_PORT || 8080) + 2}/api/trpc/films.${method === 'GET' ? 'list' : 'add'}`,
      {
        method,
        ...(method === 'POST'
          ? { data: { title: 'Should never be saved' } }
          : {})
      }
    )
    expect(response.status()).toBe(401)
    expect(response.headers()['cache-control']).toBe('private, no-store')
    expect(await response.json()).toEqual({
      error: 'Please sign in to view the watchlist.'
    })
  }
  const health = await request.get(
    `http://127.0.0.1:${Number(process.env.E2E_PORT || 8080) + 2}/healthz`
  )
  expect(health.status()).toBe(503)
  expect(await health.json()).toEqual({ ok: false })
})
