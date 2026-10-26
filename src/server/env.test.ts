import test from 'node:test'
import assert from 'node:assert/strict'
import { readAuthEnv, readDatabaseEnv, readEnv } from './env'

test('runtime settings are typed without requiring Clerk setup', () => {
  const env = readEnv({ DATABASE_URL: 'postgres://localhost:5432/films' })
  assert.equal(env.PORT, 8080)
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(env.CLERK_SECRET_KEY, undefined)
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
