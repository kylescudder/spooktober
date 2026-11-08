import test from 'node:test'
import assert from 'node:assert/strict'
import { readAuthEnv, readBetterAuthEnv, readDatabaseEnv, readEnv } from './env'

test('runtime settings are typed without requiring sign-in setup', () => {
  const env = readEnv({ DATABASE_URL: 'postgres://localhost:5432/films' })
  assert.equal(env.PORT, 8080)
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(
    readEnv({ DATABASE_URL: env.DATABASE_URL, PORT: '8123' }).PORT,
    8123
  )
})

test('migrations require only a PostgreSQL URL and errors do not expose its password', () => {
  assert.equal(
    readDatabaseEnv({ DATABASE_URL: 'postgresql://localhost/films' })
      .DATABASE_URL,
    'postgresql://localhost/films'
  )
  for (const DATABASE_URL of [
    undefined,
    '',
    'https://user:private-password@example.com/films',
    'postgres://localhost'
  ]) {
    assert.throws(
      () => readDatabaseEnv({ DATABASE_URL }),
      (error: unknown) => {
        assert.match((error as Error).message, /DATABASE_URL/)
        assert.doesNotMatch((error as Error).message, /private-password/)
        return true
      }
    )
  }
})

test('optional public origins stay empty locally and must be exact origins when supplied', () => {
  assert.equal(readAuthEnv({ PUBLIC_URL: '' }).PUBLIC_URL, undefined)
  assert.equal(
    readAuthEnv({ PUBLIC_URL: 'https://films.example.com/' }).PUBLIC_URL,
    'https://films.example.com'
  )
  for (const PUBLIC_URL of [
    'https://user:password@example.com',
    'https://example.com/path',
    'ftp://example.com'
  ]) {
    assert.throws(() => readAuthEnv({ PUBLIC_URL }), /PUBLIC_URL/)
  }
})

test('invalid runtime ports and modes are rejected', () => {
  for (const PORT of ['0', '65536', '3000.1', 'invalid'])
    assert.throws(() => readAuthEnv({ PORT }), /PORT/)
  assert.throws(() => readAuthEnv({ NODE_ENV: 'staging' }), /NODE_ENV/)
})

test('Better Auth settings are validated and never echoed', () => {
  // A leftover provider switch is ignored, whatever its value.
  assert.doesNotThrow(() => readAuthEnv({ AUTH_PROVIDER: 'auth0' }))
  const secret = 'a-private-secret-that-is-long-enough-1234'
  const complete = {
    BETTER_AUTH_URL: 'https://films.example.com/',
    BETTER_AUTH_SECRET: secret,
    BREVO_API_KEY: 'private-brevo-key',
    AUTH_EMAIL_FROM: 'films@example.com',
    AUTH_ALLOWED_EMAILS:
      ' Kyle@Example.com, rhiann@example.com,kyle@example.com '
  }
  const env = readBetterAuthEnv(complete)
  assert.equal(env.BETTER_AUTH_URL, 'https://films.example.com')
  assert.deepEqual(env.AUTH_ALLOWED_EMAILS, [
    'kyle@example.com',
    'rhiann@example.com'
  ])
  assert.equal(env.AUTH_EMAIL_DAILY_LIMIT, 40)
  assert.equal(
    readBetterAuthEnv({ ...complete, AUTH_EMAIL_DAILY_LIMIT: '12' })
      .AUTH_EMAIL_DAILY_LIMIT,
    12
  )
  for (const [key, value] of [
    ['BETTER_AUTH_URL', undefined],
    ['BETTER_AUTH_URL', 'https://films.example.com/path'],
    ['BETTER_AUTH_SECRET', 'too-short'],
    ['BREVO_API_KEY', ''],
    ['AUTH_EMAIL_FROM', 'not-an-email'],
    ['AUTH_ALLOWED_EMAILS', ''],
    ['AUTH_ALLOWED_EMAILS', 'kyle@example.com,not-an-email'],
    ['AUTH_EMAIL_DAILY_LIMIT', '0']
  ] as const)
    assert.throws(
      () => readBetterAuthEnv({ ...complete, [key]: value }),
      (error: unknown) => {
        assert.ok((error as Error).message.includes(key))
        assert.doesNotMatch((error as Error).message, /private|a-private/)
        return true
      }
    )
  // Production needs HTTPS for secure cookies and passkeys.
  assert.throws(
    () =>
      readBetterAuthEnv({
        ...complete,
        BETTER_AUTH_URL: 'http://films.example.com',
        NODE_ENV: 'production'
      }),
    /BETTER_AUTH_URL/
  )
  assert.equal(
    readBetterAuthEnv({
      ...complete,
      BETTER_AUTH_URL: 'http://127.0.0.1:3921'
    }).BETTER_AUTH_URL,
    'http://127.0.0.1:3921'
  )
})
