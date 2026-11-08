import test from 'node:test'
import assert from 'node:assert/strict'
import {
  accessFailure,
  authConfiguration,
  clerkConfiguration,
  configuration,
  guardMutationRequest
} from './auth.ts'
import { createAuthRouteHandler, isAllowedAuthPath } from './auth-route.ts'
import { appRouter } from './trpc.ts'

const config = configuration({
  CLERK_ALLOWED_USER_IDS: 'user_Kyle, user_Rhiann',
  PUBLIC_URL: 'https://films.example.com'
})

test('only the two configured Clerk user IDs can access the private list', () => {
  assert.equal(accessFailure('user_Kyle', config), null)
  assert.equal(accessFailure('user_Rhiann', config), null)
  assert.equal(accessFailure(null, config)?.status, 401)
  assert.equal(accessFailure('user_SomeoneElse', config)?.status, 403)
  assert.equal(accessFailure('user_kyle', config)?.status, 403)
  assert.deepEqual(
    configuration({ CLERK_ALLOWED_USER_IDS: 'user_Kyle' }).allowedUserIDs,
    ['user_Kyle']
  )
})

test('missing or malformed access configuration fails closed', () => {
  for (const ids of [
    undefined,
    '',
    'user_Kyle,',
    '*',
    'user_Kyle,user_Kyle',
    'user_Kyle,user_Rhiann,user_Third',
    'kyle@example.com'
  ]) {
    const invalid = configuration({ CLERK_ALLOWED_USER_IDS: ids })
    assert.equal(invalid.allowedUserIDs, null)
    assert.equal(accessFailure('user_Kyle', invalid)?.status, 503)
  }
  assert.throws(() =>
    configuration({ PUBLIC_URL: 'https://films.example.com/path' })
  )
  assert.throws(() =>
    configuration({ PUBLIC_URL: 'https://user:password@films.example.com' })
  )
  assert.equal(clerkConfiguration({}).configured, false)
  assert.equal(
    clerkConfiguration({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'replace-with-publishable-key'
    }).configured,
    false
  )
})

test('runtime Clerk keys support the existing deployment name and prefer the new name', () => {
  const legacy = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
    CLERK_SECRET_KEY: 'sk_test_fixture'
  }
  assert.equal(clerkConfiguration(legacy).configured, true)
  assert.equal(
    clerkConfiguration({
      ...legacy,
      CLERK_PUBLISHABLE_KEY: legacy.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    }).configured,
    true
  )
  assert.equal(
    clerkConfiguration({ ...legacy, CLERK_PUBLISHABLE_KEY: 'invalid' })
      .configured,
    false
  )
  assert.equal(
    clerkConfiguration({ ...legacy, CLERK_SECRET_KEY: 'sk_live_fixture' })
      .configured,
    false
  )
})

test('every tRPC procedure independently rejects signed-out and uninvited sessions before storage', async (t) => {
  const previous = process.env.CLERK_ALLOWED_USER_IDS
  process.env.CLERK_ALLOWED_USER_IDS = 'user_Kyle,user_Rhiann'
  t.after(() => {
    if (previous === undefined) delete process.env.CLERK_ALLOWED_USER_IDS
    else process.env.CLERK_ALLOWED_USER_IDS = previous
  })
  for (const userId of [null, 'user_SomeoneElse']) {
    const caller = appRouter.createCaller({ viewer: userId })
    const code = userId ? 'FORBIDDEN' : 'UNAUTHORIZED'
    for (const call of [
      () => caller.films.list(),
      () =>
        caller.films.add({
          id: '00000000-0000-4000-8000-000000000001',
          title: 'The Thing',
          year: 2026
        }),
      () =>
        caller.films.setWatched({ id: 'film-01', watched: true, year: 2026 }),
      () => caller.films.reorder({ ids: ['film-01'], year: 2026 })
    ])
      await assert.rejects(call, { code })
  }
  delete process.env.CLERK_ALLOWED_USER_IDS
  await assert.rejects(
    appRouter.createCaller({ viewer: 'user_Kyle' }).films.list(),
    { code: 'SERVICE_UNAVAILABLE' }
  )
})

test('writes require the configured public HTTPS origin, JSON and a custom request header', () => {
  const request = (extra: Record<string, string> = {}) =>
    new Request('http://spooktober:8080/api/trpc/films.add', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-spooktober-request': '1',
        origin: 'https://films.example.com',
        ...extra
      },
      body: '{}'
    })
  assert.equal(guardMutationRequest(request(), config), null)
  assert.equal(
    guardMutationRequest(
      request({ origin: 'https://elsewhere.example' }),
      config
    )?.status,
    403
  )
  assert.equal(
    guardMutationRequest(request({ 'sec-fetch-site': 'cross-site' }), config)
      ?.status,
    403
  )
  assert.equal(
    guardMutationRequest(request({ 'x-spooktober-request': '' }), config)
      ?.status,
    403
  )
  assert.equal(
    guardMutationRequest(request({ 'content-type': 'text/plain' }), config)
      ?.status,
    415
  )
  assert.equal(
    guardMutationRequest(
      new Request('https://films.example.com/api/trpc/films.list'),
      config
    ),
    null
  )
})

const betterAuthEnv = {
  AUTH_PROVIDER: 'better-auth',
  BETTER_AUTH_URL: 'https://films.example.com',
  BETTER_AUTH_SECRET: 'a-disposable-secret-that-is-long-enough',
  BREVO_API_KEY: 'fixture-never-used-to-send',
  AUTH_EMAIL_FROM: 'films@example.com',
  AUTH_ALLOWED_EMAILS: 'kyle@example.com, Rhiann@example.com',
  PUBLIC_URL: 'https://films.example.com'
}

test('Better Auth access needs a verified email that is still invited', () => {
  const config = configuration(betterAuthEnv)
  assert.equal(config.provider, 'better-auth')
  const kyle = { id: 'a', email: 'kyle@example.com', emailVerified: true }
  assert.equal(accessFailure(kyle, config), null)
  assert.equal(
    accessFailure({ ...kyle, email: 'RHIANN@example.com' }, config),
    null
  )
  assert.equal(accessFailure(null, config)?.status, 401)
  assert.equal(
    accessFailure({ ...kyle, emailVerified: false }, config)?.status,
    403
  )
  assert.equal(
    accessFailure({ ...kyle, email: 'someone@example.com' }, config)?.status,
    403
  )
  // Removing an address revokes access for its existing sessions.
  const removed = configuration({
    ...betterAuthEnv,
    AUTH_ALLOWED_EMAILS: 'rhiann@example.com'
  })
  assert.equal(accessFailure(kyle, removed)?.status, 403)
  // A Clerk ID never satisfies Better Auth, and a Better Auth user never
  // satisfies Clerk, even when the other provider's settings are present.
  assert.equal(accessFailure('user_Kyle', config)?.status, 503)
  const clerk = configuration({
    ...betterAuthEnv,
    AUTH_PROVIDER: 'clerk',
    CLERK_ALLOWED_USER_IDS: 'user_Kyle'
  })
  assert.equal(accessFailure(kyle, clerk)?.status, 503)
  assert.equal(accessFailure('user_Kyle', clerk), null)
  // Missing settings keep the setup response instead of opening access.
  for (const key of [
    'BETTER_AUTH_SECRET',
    'BREVO_API_KEY',
    'AUTH_ALLOWED_EMAILS'
  ]) {
    const partial = { ...betterAuthEnv, [key]: '' }
    assert.equal(authConfiguration(partial).configured, false)
    assert.equal(accessFailure(kyle, configuration(partial))?.status, 503)
  }
  assert.equal(authConfiguration(betterAuthEnv).configured, true)
  assert.equal(authConfiguration(betterAuthEnv).publishableKey, '')
})

test('Clerk stays the default provider with unchanged configuration', () => {
  const legacy = {
    CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
    CLERK_SECRET_KEY: 'sk_test_fixture'
  }
  assert.deepEqual(authConfiguration(legacy), {
    provider: 'clerk',
    ...clerkConfiguration(legacy)
  })
  assert.equal(configuration(legacy).allowedEmails, null)
  // Better Auth settings are ignored while Clerk is selected.
  assert.equal(
    authConfiguration({ ...legacy, AUTH_ALLOWED_EMAILS: 'not-an-email' })
      .configured,
    true
  )
})

test('the app forwards only the Better Auth endpoints it uses', async () => {
  for (const path of [
    '/get-session',
    '/sign-out',
    '/update-user',
    '/email-otp/send-verification-otp',
    '/sign-in/email-otp',
    '/sign-in/email',
    '/sign-in/magic-link',
    '/magic-link/verify',
    '/request-password-reset',
    '/reset-password',
    '/reset-password/abc-DEF_123',
    '/change-password',
    '/list-accounts',
    '/passkey/generate-register-options',
    '/passkey/verify-authentication',
    '/passkey/delete-passkey'
  ])
    assert.ok(isAllowedAuthPath(path), path)
  for (const path of [
    '/sign-up/email',
    '/email-otp/get-verification-otp',
    '/email-otp/request-password-reset',
    '/forget-password/email-otp',
    '/change-email',
    '/delete-user',
    '/list-sessions',
    '/reset-password/abc/def',
    '/ok'
  ])
    assert.ok(!isAllowedAuthPath(path), path)

  const forwarded: string[] = []
  const fake = {
    handler: async (request: Request) => {
      forwarded.push(new URL(request.url).pathname)
      return new Response('ok')
    },
    api: { getSession: async () => null }
  }
  const request = (path: string) =>
    new Request('https://films.example.com/api/auth' + path, {
      method: 'POST'
    })
  const betterAuth = createAuthRouteHandler(
    () => fake,
    () => 'better-auth'
  )
  assert.equal((await betterAuth(request('/sign-in/email'))).status, 200)
  assert.equal((await betterAuth(request('/sign-up/email'))).status, 404)
  // Nothing reaches Better Auth while Clerk is selected.
  const clerk = createAuthRouteHandler(
    () => fake,
    () => 'clerk'
  )
  assert.equal((await clerk(request('/get-session'))).status, 404)
  assert.deepEqual(forwarded, ['/api/auth/sign-in/email'])
})
