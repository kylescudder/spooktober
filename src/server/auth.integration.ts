// Better Auth against a real, disposable PostgreSQL database. Mail delivery is
// captured in memory; nothing here talks to Brevo or production.
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import {
  createDatabase,
  type Database,
  importFilms,
  migrateDatabase
} from './database.ts'
import { parseWatchlist } from './watchlist.ts'
import { createSpooktoberAuth } from './auth-factory.ts'
import { createAuthRouteHandler } from './auth-route.ts'
import { createTrpcHandler } from './trpc-handler.ts'
import { createProfileHandler } from './profile-handler.ts'
import { handleProfileRequest } from './profile.ts'
import { virtualAuthenticator } from './fixtures/webauthn.ts'

const authOrigin = 'https://spooktober.auth.test'
const allowedEmails = ['kyle@example.com', 'rhiann@example.com']
let fixtureNumber = 0

async function authFixture(
  t: TestContext,
  { dailyEmailLimit = 40, failMail = false } = {}
) {
  const value = process.env.TEST_DATABASE_URL
  if (!value || !new URL(value).pathname.endsWith('_test'))
    throw new Error(
      'TEST_DATABASE_URL must point to a disposable PostgreSQL control database ending in _test.'
    )
  const control = createDatabase(value)
  const name = `spooktober_test_${randomUUID().replaceAll('-', '')}`
  await control.$client.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(value)
  url.pathname = `/${name}`
  const db = createDatabase(url.href)
  await migrateDatabase(db)
  await importFilms(db, parseWatchlist(await readFile('src/seed.json')))
  const globals = globalThis as typeof globalThis & {
    spooktoberDatabase?: Database
  }
  const previous = { ...process.env }
  const secret = randomUUID() + randomUUID()
  Object.assign(process.env, {
    DATABASE_URL: url.href,
    AUTH_PROVIDER: 'better-auth',
    BETTER_AUTH_URL: authOrigin,
    BETTER_AUTH_SECRET: secret,
    BREVO_API_KEY: 'fixture-never-used-to-send',
    AUTH_EMAIL_FROM: 'films@example.com',
    AUTH_ALLOWED_EMAILS: allowedEmails.join(','),
    PUBLIC_URL: authOrigin
  })
  globals.spooktoberDatabase = db
  t.after(async () => {
    delete globals.spooktoberDatabase
    process.env = previous
    await db.$client.end()
    await control.$client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await control.$client.end()
  })
  const sent = new Map<string, string>()
  const links: { email: string; kind: string; url: string }[] = []
  const settings = {
    baseURL: authOrigin,
    secret,
    allowedEmails,
    dailyEmailLimit
  }
  const auth = createSpooktoberAuth(
    db,
    settings,
    async (email, otp) => {
      if (failMail) throw new Error('Simulated mail outage')
      sent.set(email, otp)
    },
    async (email, kind, url) => {
      if (failMail) throw new Error('Simulated mail outage')
      links.push({ email, kind, url })
    }
  )
  const route = createAuthRouteHandler(
    () => auth,
    () => 'better-auth'
  )
  const ip = `203.0.113.${++fixtureNumber}`
  function request(
    path: string,
    body?: unknown,
    cookie = '',
    extra: Record<string, string> = {}
  ) {
    return route(
      new Request(authOrigin + '/api/auth' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: authOrigin,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
          Cookie: cookie,
          ...extra
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    )
  }
  // The app's tRPC endpoint, resolving the viewer from this Better Auth.
  const trpc = createTrpcHandler(async (request) => {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) return null
    const { id, email, emailVerified } = session.user
    return { id, email, emailVerified }
  })
  const films = (cookie: string) =>
    trpc(
      new Request(authOrigin + '/api/trpc/films.list', {
        headers: { Cookie: cookie }
      })
    )
  return { auth, db, request, route, sent, links, settings, films }
}

type Fixture = Awaited<ReturnType<typeof authFixture>>

function mergeCookies(response: Response, prior = '') {
  const values = new Map(
    prior
      .split('; ')
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return [part.slice(0, index), part.slice(index + 1)]
      })
  )
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0]!
    const index = pair.indexOf('=')
    values.set(pair.slice(0, index), pair.slice(index + 1))
  }
  return [...values].map(([key, value]) => key + '=' + value).join('; ')
}

async function signIn(fixture: Fixture, email = 'kyle@example.com') {
  const sent = await fixture.request('/email-otp/send-verification-otp', {
    email,
    type: 'sign-in'
  })
  assert.equal(sent.status, 200, await sent.clone().text())
  const response = await fixture.request('/sign-in/email-otp', {
    email,
    otp: fixture.sent.get(email)
  })
  assert.equal(response.status, 200, await response.clone().text())
  return {
    cookie: mergeCookies(response),
    user: (await response.clone().json()).user as {
      id: string
      email: string
      emailVerified: boolean
    }
  }
}

const rows = (db: Database, query: string) => db.$client.unsafe(query)

test('email-code sign-in is allowlisted, hashed, single-use and opens the watchlist', async (t) => {
  const fixture = await authFixture(t)
  const outsider = await fixture.request('/email-otp/send-verification-otp', {
    email: 'outsider@example.com',
    type: 'sign-in'
  })
  assert.equal(outsider.status, 200)
  assert.deepEqual(await outsider.json(), { success: true })
  assert.equal(fixture.sent.size, 0)
  assert.equal(
    (await rows(fixture.db, 'SELECT id FROM auth_verification')).length,
    0
  )
  const sent = await fixture.request('/email-otp/send-verification-otp', {
    email: ' KYLE@example.com',
    type: 'sign-in'
  })
  assert.equal(sent.status, 200)
  const otp = fixture.sent.get('kyle@example.com')!
  assert.match(otp, /^\d{6}$/)
  const [stored] = await rows(fixture.db, 'SELECT value FROM auth_verification')
  assert.match(stored!.value, /^[a-f0-9]{64}:0$/)
  assert.notEqual(stored!.value.split(':')[0], otp, 'Raw OTP was persisted')
  // Per-recipient cooldown: a second email within the minute is not sent, and
  // looks exactly like the answer for an address that gets no mail.
  const tooSoon = await fixture.request('/email-otp/send-verification-otp', {
    email: 'kyle@example.com',
    type: 'sign-in'
  })
  assert.equal(tooSoon.status, 200)
  assert.deepEqual(await tooSoon.json(), { success: true })
  assert.equal(fixture.sent.get('kyle@example.com'), otp)
  const signedIn = await fixture.request('/sign-in/email-otp', {
    email: 'kyle@example.com',
    otp
  })
  assert.equal(signedIn.status, 200, await signedIn.clone().text())
  assert.equal((await signedIn.clone().json()).user.emailVerified, true)
  const cookies = signedIn.headers.getSetCookie().join(';')
  assert.match(cookies, /spooktober-auth/)
  assert.match(cookies, /HttpOnly/i)
  assert.match(cookies, /Secure/i)
  assert.match(cookies, /SameSite=Lax/i)
  assert.ok(!/Domain=/i.test(cookies), 'Session cookie escaped the hostname')
  const cookie = mergeCookies(signedIn)
  const films = await fixture.films(cookie)
  assert.equal(films.status, 200)
  assert.equal((await films.json()).result.data.length, 20)
  assert.equal((await fixture.films('')).status, 401)
  // Rolling back to Clerk: a Better Auth session never satisfies Clerk.
  process.env.AUTH_PROVIDER = 'clerk'
  process.env.CLERK_ALLOWED_USER_IDS = 'user_Kyle,user_Rhiann'
  assert.equal((await fixture.films(cookie)).status, 503)
  process.env.AUTH_PROVIDER = 'better-auth'
  // Codes are single-use.
  assert.equal(
    (
      await fixture.request('/sign-in/email-otp', {
        email: 'kyle@example.com',
        otp
      })
    ).status,
    400
  )
  assert.equal((await fixture.request('/sign-out', {}, cookie)).status, 200)
  assert.equal(
    await (await fixture.request('/get-session', undefined, cookie)).json(),
    null
  )
  assert.equal((await fixture.films(cookie)).status, 401)
})

test('a throttled allowlisted address gets the same answer as an unlisted one', async (t) => {
  const fixture = await authFixture(t)
  const endpoints = [
    ['/email-otp/send-verification-otp', { type: 'sign-in' }],
    ['/sign-in/magic-link', { callbackURL: '/' }],
    ['/request-password-reset', { redirectTo: '/auth/reset-password' }]
  ] as const
  let address = 100
  const answer = async (path: string, extra: object, email: string) => {
    // A fresh IP each time keeps the per-IP send limit out of the comparison.
    const response = await fixture.request(path, { email, ...extra }, '', {
      'CF-Connecting-IP': `198.51.100.${++address}`
    })
    return { status: response.status, body: await response.text() }
  }
  assert.equal(
    (await answer(endpoints[0][0], endpoints[0][1], 'kyle@example.com')).status,
    200
  )
  const otp = fixture.sent.get('kyle@example.com')!
  for (const [path, extra] of endpoints) {
    const throttled = await answer(path, extra, 'kyle@example.com')
    const unlisted = await answer(path, extra, 'stranger@example.com')
    assert.deepEqual(throttled, unlisted, path)
    assert.equal(throttled.status, 200, path)
  }
  // Nothing more was sent or charged, and the first code still works.
  assert.equal(fixture.links.length, 0)
  assert.equal(fixture.sent.get('kyle@example.com'), otp)
  assert.equal(fixture.sent.size, 1)
  const [global] = await rows(
    fixture.db,
    "SELECT count FROM auth_email_limit WHERE key = 'global:day'"
  )
  assert.equal(global!.count, 1)
  assert.equal(
    (
      await fixture.request('/sign-in/email-otp', {
        email: 'kyle@example.com',
        otp
      })
    ).status,
    200
  )
})

test('OTP attempts, expiry and cross-site sends are refused without creating accounts', async (t) => {
  const fixture = await authFixture(t)
  const crossSite = await fixture.request(
    '/email-otp/send-verification-otp',
    { email: 'kyle@example.com', type: 'sign-in' },
    '',
    { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }
  )
  assert.equal(crossSite.status, 403)
  assert.equal(fixture.sent.size, 0)
  assert.equal(
    (await rows(fixture.db, 'SELECT key FROM auth_email_limit')).length,
    0
  )
  // Only sign-in codes exist; verification and reset codes are refused.
  assert.equal(
    (
      await fixture.request('/email-otp/send-verification-otp', {
        email: 'kyle@example.com',
        type: 'forget-password'
      })
    ).status,
    400
  )
  await fixture.request('/email-otp/send-verification-otp', {
    email: 'kyle@example.com',
    type: 'sign-in'
  })
  const otp = fixture.sent.get('kyle@example.com')!
  const wrong = otp === '000000' ? '111111' : '000000'
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal(
      (
        await fixture.request('/sign-in/email-otp', {
          email: 'kyle@example.com',
          otp: wrong
        })
      ).status,
      400
    )
  const exhausted = await fixture.request('/sign-in/email-otp', {
    email: 'kyle@example.com',
    otp
  })
  assert.equal(exhausted.status, 403)
  await fixture.request('/email-otp/send-verification-otp', {
    email: 'rhiann@example.com',
    type: 'sign-in'
  })
  await rows(
    fixture.db,
    `UPDATE auth_verification SET expires_at = now() - interval '1 second'`
  )
  assert.equal(
    (
      await fixture.request('/sign-in/email-otp', {
        email: 'rhiann@example.com',
        otp: fixture.sent.get('rhiann@example.com')
      })
    ).status,
    400
  )
  assert.equal((await rows(fixture.db, 'SELECT id FROM auth_user')).length, 0)
})

test('the app-wide email budget and rate limits persist in PostgreSQL', async (t) => {
  const fixture = await authFixture(t, { dailyEmailLimit: 1 })
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      fixture.request('/email-otp/send-verification-otp', {
        email: 'kyle@example.com',
        type: 'sign-in'
      })
    )
  )
  assert.equal(responses.filter((r) => r.status === 200).length, 1)
  assert.equal(responses.filter((r) => r.status === 429).length, 3)
  assert.equal(fixture.sent.size, 1)
  // Another recipient shares the same daily budget.
  assert.equal(
    (
      await fixture.request('/email-otp/send-verification-otp', {
        email: 'rhiann@example.com',
        type: 'sign-in'
      })
    ).status,
    429
  )
  // A restarted instance still sees this IP's send limit (3 per minute).
  const restarted = createSpooktoberAuth(
    fixture.db,
    fixture.settings,
    async () => {
      throw new Error('Must not send')
    }
  )
  const response = await restarted.handler(
    new Request(authOrigin + '/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: {
        Origin: authOrigin,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': `203.0.113.${fixtureNumber}`
      },
      body: JSON.stringify({ email: 'outsider@example.com', type: 'sign-in' })
    })
  )
  assert.equal(response.status, 429)
  assert.ok(
    (await rows(fixture.db, 'SELECT id FROM auth_rate_limit')).length > 0
  )
})

test('unverified or removed emails lose watchlist access and cannot enrol passkeys', async (t) => {
  const fixture = await authFixture(t)
  const { cookie, user } = await signIn(fixture)
  await rows(
    fixture.db,
    `UPDATE auth_user SET email_verified = false WHERE id = '${user.id}'`
  )
  assert.equal((await fixture.films(cookie)).status, 403)
  assert.equal(
    (
      await fixture.request(
        '/passkey/generate-register-options',
        undefined,
        cookie
      )
    ).status,
    401
  )
  await rows(
    fixture.db,
    `UPDATE auth_user SET email_verified = true WHERE id = '${user.id}'`
  )
  assert.equal((await fixture.films(cookie)).status, 200)
  // Removing the address from AUTH_ALLOWED_EMAILS revokes the live session.
  process.env.AUTH_ALLOWED_EMAILS = 'rhiann@example.com'
  assert.equal((await fixture.films(cookie)).status, 403)
  process.env.AUTH_ALLOWED_EMAILS = allowedEmails.join(',')
  assert.equal(
    (await fixture.request('/passkey/generate-register-options')).status,
    401
  )
})

test('profile updates change names only', async (t) => {
  const fixture = await authFixture(t)
  const { cookie, user } = await signIn(fixture)
  const update = (body: unknown, origin = authOrigin) =>
    fixture.request('/update-user', body, cookie, { Origin: origin })
  assert.equal(
    (await update({ name: 'Kyle', givenName: 'Kyle', familyName: 'S' })).status,
    200
  )
  for (const body of [
    { email: 'other@example.com' },
    { emailVerified: false },
    { image: 'https://attacker.example/x.png' },
    { name: 'Kyle', image: 'data:image/png;base64,AAAA' }
  ])
    assert.equal((await update(body)).status, 400, JSON.stringify(body))
  assert.equal(
    (await update({ name: 'Cross' }, 'https://evil.example')).status,
    403
  )
  const [stored] = await rows(
    fixture.db,
    `SELECT name, given_name, family_name, email, email_verified, image FROM auth_user WHERE id = '${user.id}'`
  )
  assert.deepEqual(
    { ...stored },
    {
      name: 'Kyle',
      given_name: 'Kyle',
      family_name: 'S',
      email: 'kyle@example.com',
      email_verified: true,
      image: null
    }
  )
})

test('profile photos are re-encoded without metadata, private to their owner and removable', async (t) => {
  const fixture = await authFixture(t)
  const { cookie, user } = await signIn(fixture)
  const other = await signIn(fixture, 'rhiann@example.com')
  const handler = createProfileHandler(fixture.db, {
    origin: authOrigin,
    allowedEmails: () => process.env.AUTH_ALLOWED_EMAILS!.split(','),
    getSession: (headers) => fixture.auth.api.getSession({ headers })
  })
  const photo = await sharp({
    create: { width: 64, height: 32, channels: 3, background: '#ff7518' }
  })
    .jpeg()
    .withMetadata({
      exif: { IFD0: { Artist: 'Metadata to strip', Copyright: 'GPS here' } }
    })
    .toBuffer()
  assert.ok((await sharp(photo).metadata()).exif, 'Fixture must carry EXIF')
  const avatar = (
    method = 'GET',
    body?: BodyInit,
    type = 'image/jpeg',
    session = cookie,
    extra: Record<string, string> = {}
  ) =>
    handler(
      new Request(authOrigin + '/api/profile/avatar', {
        method,
        body,
        headers: {
          Origin: authOrigin,
          Cookie: session,
          'Content-Type': type,
          ...extra
        }
      })
    )
  const update = (body: unknown, session = cookie) =>
    fixture.request('/update-user', body, session)
  const storedImage = async (id = user.id) =>
    (
      await rows(fixture.db, `SELECT image FROM auth_user WHERE id = '${id}'`)
    )[0]!.image

  // Signed out, cross-site and non-image uploads are refused.
  assert.equal(
    (await avatar('PUT', new Uint8Array(photo), 'image/jpeg', '')).status,
    401
  )
  assert.equal((await avatar('GET', undefined, 'image/jpeg', '')).status, 401)
  assert.equal(
    (
      await avatar('PUT', new Uint8Array(photo), 'image/jpeg', cookie, {
        Origin: 'https://evil.example'
      })
    ).status,
    403
  )
  assert.equal(
    (await avatar('PUT', '<svg onload="alert(1)"/>', 'image/svg+xml')).status,
    415
  )
  assert.equal(
    (await avatar('PUT', '<svg onload="alert(1)"/>', 'image/png')).status,
    400
  )
  assert.equal((await avatar('PUT', 'GIF89a not allowed')).status, 400)
  // A JPEG signature that the decoder cannot read is still refused.
  assert.equal(
    (await avatar('PUT', new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2]))).status,
    400
  )
  // Size limit, whether or not Content-Length is declared.
  const tooLarge = new Uint8Array(2 * 1024 * 1024 + 1)
  tooLarge.set([0xff, 0xd8, 0xff])
  assert.equal((await avatar('PUT', tooLarge)).status, 413)
  assert.equal(
    (
      await avatar(
        'PUT',
        new ReadableStream({
          start(controller) {
            controller.enqueue(tooLarge)
            controller.close()
          }
        }),
        'image/jpeg',
        cookie
      )
    ).status,
    413
  )
  assert.equal(await storedImage(), null)

  // Upload: a private, versioned, metadata-free 256px JPEG.
  const first = await avatar('PUT', new Uint8Array(photo))
  assert.equal(first.status, 200, await first.clone().text())
  const { image: firstImage } = (await first.json()) as { image: string }
  assert.match(firstImage, /^\/api\/profile\/avatar\?v=[0-9a-f-]{36}$/)
  assert.equal(await storedImage(), firstImage)
  const picture = await avatar()
  assert.equal(picture.status, 200)
  assert.equal(picture.headers.get('Content-Type'), 'image/jpeg')
  assert.match(picture.headers.get('Cache-Control')!, /no-store/)
  assert.equal(picture.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(
    picture.headers.get('Cross-Origin-Resource-Policy'),
    'same-origin'
  )
  const metadata = await sharp(
    Buffer.from(await picture.arrayBuffer())
  ).metadata()
  assert.equal(metadata.format, 'jpeg')
  assert.equal(metadata.width, 256)
  assert.equal(metadata.height, 256)
  assert.equal(metadata.exif, undefined)
  assert.equal(metadata.icc, undefined)

  // Better Auth UI confirms the returned URL; only the owner's current one.
  assert.equal((await update({ image: firstImage })).status, 200)
  assert.equal((await update({ image: firstImage }, other.cookie)).status, 400)
  assert.equal((await update({ image: null })).status, 400)
  assert.equal(
    (await update({ image: '/api/profile/avatar?v=guessed' })).status,
    400
  )

  // Another user can neither read nor replace it.
  assert.equal(
    (await avatar('GET', undefined, 'image/jpeg', other.cookie)).status,
    404
  )
  const png = await sharp({
    create: { width: 40, height: 40, channels: 4, background: '#123456' }
  })
    .png()
    .toBuffer()
  assert.equal(
    (await avatar('PUT', new Uint8Array(png), 'image/png', other.cookie))
      .status,
    200
  )
  assert.equal(await storedImage(), firstImage)
  assert.notEqual(await storedImage(other.user.id), null)

  // Replace: a new version every time.
  const replaced = await avatar('PUT', new Uint8Array(png), 'image/png')
  assert.equal(replaced.status, 200)
  const { image: nextImage } = (await replaced.json()) as { image: string }
  assert.notEqual(nextImage, firstImage)
  assert.equal(await storedImage(), nextImage)
  assert.equal((await update({ image: firstImage })).status, 400)

  // Unverified or removed emails lose access, even with a live session.
  await rows(
    fixture.db,
    `UPDATE auth_user SET email_verified = false WHERE id = '${user.id}'`
  )
  assert.equal((await avatar()).status, 403)
  await rows(
    fixture.db,
    `UPDATE auth_user SET email_verified = true WHERE id = '${user.id}'`
  )
  process.env.AUTH_ALLOWED_EMAILS = 'rhiann@example.com'
  assert.equal((await avatar()).status, 403)
  assert.equal((await avatar('DELETE')).status, 403)
  process.env.AUTH_ALLOWED_EMAILS = allowedEmails.join(',')

  // Delete clears both the photo and the user's image.
  const removed = await avatar('DELETE')
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { image: null })
  assert.equal(await storedImage(), null)
  assert.equal((await avatar()).status, 404)
  assert.equal((await update({ image: null })).status, 200)
  assert.equal(
    (
      await avatar('DELETE', undefined, 'image/jpeg', cookie, {
        Origin: 'https://evil.example'
      })
    ).status,
    403
  )
  assert.equal((await avatar('POST')).status, 405)

  // The app route: Better Auth uses this handler; Clerk mode has no endpoint.
  const globals = globalThis as typeof globalThis & { spooktoberAuth?: unknown }
  delete globals.spooktoberAuth
  t.after(() => {
    delete globals.spooktoberAuth
  })
  const routed = await handleProfileRequest(
    new Request(authOrigin + '/api/profile/avatar', {
      headers: { Cookie: other.cookie }
    })
  )
  assert.equal(routed.status, 200)
  assert.equal(routed.headers.get('Content-Type'), 'image/jpeg')
  assert.equal(
    (
      await handleProfileRequest(
        new Request(authOrigin + '/api/profile/avatar')
      )
    ).status,
    401
  )
  process.env.AUTH_PROVIDER = 'clerk'
  for (const method of ['GET', 'PUT', 'DELETE'])
    assert.equal(
      (
        await handleProfileRequest(
          new Request(authOrigin + '/api/profile/avatar', {
            method,
            headers: { Cookie: other.cookie, Origin: authOrigin }
          })
        )
      ).status,
      404,
      method
    )
  process.env.AUTH_PROVIDER = 'better-auth'

  // Deleting the account removes its photo row.
  await rows(fixture.db, `DELETE FROM auth_user WHERE id = '${other.user.id}'`)
  const [left] = await rows(
    fixture.db,
    `SELECT count(*)::int AS photos FROM user_profile WHERE user_id = '${other.user.id}'`
  )
  assert.equal(left!.photos, 0)
})

test('passkeys enrol after verified sign-in and refuse replayed or foreign assertions', async (t) => {
  const fixture = await authFixture(t)
  const { cookie, user } = await signIn(fixture)
  const authenticator = virtualAuthenticator(authOrigin)
  const registration = await fixture.request(
    '/passkey/generate-register-options',
    undefined,
    cookie
  )
  assert.equal(registration.status, 200, await registration.clone().text())
  const options = await registration.json()
  assert.equal(options.rp.id, new URL(authOrigin).hostname)
  assert.equal(options.authenticatorSelection.userVerification, 'required')
  assert.equal(options.authenticatorSelection.residentKey, 'required')
  const registered = await fixture.request(
    '/passkey/verify-registration',
    { response: authenticator.registration(options.challenge), name: 'Test' },
    mergeCookies(registration, cookie)
  )
  assert.equal(registered.status, 200, await registered.clone().text())
  await fixture.request('/sign-out', {}, cookie)
  const challenge = await fixture.request(
    '/passkey/generate-authenticate-options'
  )
  const { challenge: value } = await challenge.json()
  const assertion = authenticator.assertion(value, user.id)
  const signedIn = await fixture.request(
    '/passkey/verify-authentication',
    { response: assertion },
    mergeCookies(challenge)
  )
  assert.equal(signedIn.status, 200, await signedIn.clone().text())
  assert.equal((await fixture.films(mergeCookies(signedIn))).status, 200)
  assert.equal(
    (
      await fixture.request(
        '/passkey/verify-authentication',
        { response: assertion },
        mergeCookies(challenge)
      )
    ).status,
    400
  )
  const next = await fixture.request('/passkey/generate-authenticate-options')
  const rejected = await fixture.request(
    '/passkey/verify-authentication',
    {
      response: authenticator.assertion(
        (await next.json()).challenge,
        user.id,
        {
          origin: 'https://evil.example',
          counter: 2
        }
      )
    },
    mergeCookies(next)
  )
  assert.ok(rejected.status >= 400)
})

test('password, reset links and magic links are allowlisted and sign-up stays closed', async (t) => {
  const fixture = await authFixture(t)
  const password = 'correct horse battery staple'
  // The app route hides sign-up; Better Auth itself refuses it too.
  assert.equal(
    (
      await fixture.request('/sign-up/email', {
        email: 'kyle@example.com',
        password,
        name: 'Kyle'
      })
    ).status,
    404
  )
  const direct = await fixture.auth.handler(
    new Request(authOrigin + '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { Origin: authOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'kyle@example.com', password, name: 'K' })
    })
  )
  assert.equal(direct.status, 400)
  const { user } = await signIn(fixture)
  assert.equal(
    (
      await fixture.request('/sign-in/email', {
        email: 'kyle@example.com',
        password
      })
    ).status,
    401
  )
  await rows(fixture.db, 'DELETE FROM auth_email_limit')
  for (const email of ['stranger@example.com', 'KYLE@example.com '])
    assert.equal(
      (
        await fixture.request('/request-password-reset', {
          email,
          redirectTo: '/auth/reset-password'
        })
      ).status,
      200
    )
  assert.deepEqual(
    fixture.links.map(({ email, kind }) => [email, kind]),
    [['kyle@example.com', 'reset-password']]
  )
  const resetUrl = new URL(fixture.links[0]!.url)
  assert.equal(resetUrl.origin, authOrigin)
  // The emailed link reaches Better Auth through the app route.
  const landing = await fixture.request(
    resetUrl.pathname.replace('/api/auth', '') + resetUrl.search
  )
  assert.equal(landing.status, 302)
  const token = resetUrl.pathname.split('/').at(-1)!
  const [record] = await rows(
    fixture.db,
    `SELECT identifier FROM auth_verification WHERE identifier = 'reset-password:${token}'`
  )
  assert.ok(record)
  assert.equal(
    (await fixture.request('/reset-password', { newPassword: 'short', token }))
      .status,
    400
  )
  const reset = await fixture.request('/reset-password', {
    newPassword: password,
    token
  })
  assert.equal(reset.status, 200, await reset.clone().text())
  assert.equal(
    (
      await fixture.request('/reset-password', {
        newPassword: password + '!',
        token
      })
    ).status,
    400,
    'Reset tokens are single-use'
  )
  assert.equal(
    (
      await fixture.request('/sign-in/email', {
        email: 'kyle@example.com',
        password: 'wrong password entirely'
      })
    ).status,
    401
  )
  const signedIn = await fixture.request('/sign-in/email', {
    email: 'kyle@example.com',
    password
  })
  assert.equal(signedIn.status, 200, await signedIn.clone().text())
  const session = await fixture.request(
    '/get-session',
    undefined,
    mergeCookies(signedIn)
  )
  assert.equal((await session.json()).user.id, user.id)

  fixture.links.length = 0
  assert.equal(
    (
      await fixture.request('/sign-in/magic-link', {
        email: 'stranger@example.com',
        callbackURL: '/'
      })
    ).status,
    200
  )
  assert.equal(fixture.links.length, 0)
  for (const callbackURL of [
    'https://attacker.example/',
    '//attacker.example/',
    '/.//attacker.example/',
    '/\t/attacker.example/',
    '/\\attacker.example/'
  ]) {
    await rows(fixture.db, 'DELETE FROM auth_rate_limit')
    assert.equal(
      (
        await fixture.request('/sign-in/magic-link', {
          email: 'rhiann@example.com',
          callbackURL
        })
      ).status,
      403,
      JSON.stringify(callbackURL)
    )
  }
  await rows(fixture.db, 'DELETE FROM auth_rate_limit')
  assert.equal(
    (
      await fixture.request('/request-password-reset', {
        email: 'kyle@example.com',
        redirectTo: 'https://attacker.example/reset'
      })
    ).status,
    403
  )
  assert.equal(fixture.links.length, 0)
  const requested = await fixture.request('/sign-in/magic-link', {
    email: 'rhiann@example.com',
    callbackURL: authOrigin + '/?year=2025'
  })
  assert.equal(requested.status, 200, await requested.clone().text())
  assert.deepEqual(
    fixture.links.map(({ email, kind }) => [email, kind]),
    [['rhiann@example.com', 'magic-link']]
  )
  const magic = new URL(fixture.links[0]!.url)
  assert.equal(magic.origin, authOrigin)
  const verify = () =>
    fixture.route(
      new Request(magic, {
        headers: { 'CF-Connecting-IP': '203.0.113.250' },
        redirect: 'manual'
      })
    )
  const verified = await verify()
  assert.equal(verified.status, 302)
  assert.equal(verified.headers.get('location'), authOrigin + '/?year=2025')
  const magicUser = (
    await (
      await fixture.request('/get-session', undefined, mergeCookies(verified))
    ).json()
  ).user
  assert.equal(magicUser.email, 'rhiann@example.com')
  assert.equal(magicUser.emailVerified, true)
  const replay = await verify()
  assert.equal(mergeCookies(replay).includes('session_token'), false)
  const [strangers] = await rows(
    fixture.db,
    `SELECT count(*)::int AS users FROM auth_user WHERE email = 'stranger@example.com'`
  )
  assert.equal(strangers!.users, 0)
})

test('mail outages answer generically and the app route exposes only used endpoints', async (t) => {
  const fixture = await authFixture(t, { failMail: true })
  assert.equal(
    (
      await fixture.request('/email-otp/send-verification-otp', {
        email: 'kyle@example.com',
        type: 'sign-in'
      })
    ).status,
    200
  )
  for (const path of [
    '/email-otp/get-verification-otp',
    '/email-otp/request-password-reset',
    '/forget-password/email-otp',
    '/sign-up/email',
    '/delete-user',
    '/change-email'
  ])
    assert.equal((await fixture.request(path, {})).status, 404, path)
  for (const [path, method] of [
    ['/sign-in/email', 'POST'],
    ['/sign-in/magic-link', 'POST'],
    ['/request-password-reset', 'POST'],
    ['/reset-password', 'POST'],
    ['/change-password', 'POST'],
    ['/list-accounts', 'GET'],
    ['/passkey/generate-authenticate-options', 'GET']
  ])
    assert.notEqual(
      (await fixture.request(path, method === 'GET' ? undefined : {})).status,
      404,
      path
    )
  // With Clerk selected (the default), no Better Auth endpoint is reachable.
  const clerk = createAuthRouteHandler(
    () => fixture.auth,
    () => 'clerk'
  )
  for (const path of ['/get-session', '/sign-in/email-otp', '/sign-in/email'])
    assert.equal(
      (await clerk(new Request(authOrigin + '/api/auth' + path))).status,
      404
    )
})
