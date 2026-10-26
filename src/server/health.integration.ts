import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, database, migrateDatabase } from './database.ts'
import { stallHealthQueries } from './postgres-proxy.ts'

test('health deadlines stop SQL, preserve the pool and recover', async () => {
  const value = process.env.TEST_DATABASE_URL
  if (!value || !new URL(value).pathname.endsWith('_test')) {
    throw new Error(
      'TEST_DATABASE_URL must name a disposable control database ending in _test'
    )
  }
  const control = createDatabase(value)
  const name = 'spook_health_' + randomUUID().replaceAll('-', '')
  await control.$client.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(value)
  url.pathname = '/' + name
  const owner = createDatabase(url.toString())
  const proxy = await stallHealthQueries(
    url.toString(),
    /^SELECT id FROM films LIMIT 0$/i
  )
  proxy.allowNewConnections()
  process.env.DATABASE_URL = proxy.url
  process.env.SPOOKTOBER_REVISION = 'health-test'
  const app = database()
  const { healthResponse } = await import('./health.ts')
  try {
    await migrateDatabase(owner)
    assert.equal((await healthResponse()).status, 200)
    const lock = await owner.$client.reserve()
    try {
      await lock`BEGIN`
      await lock`LOCK TABLE films IN ACCESS EXCLUSIVE MODE`
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => healthResponse())
      )
      for (const response of responses) {
        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { ok: false })
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
        assert.equal(
          response.headers.get('X-Spooktober-Revision'),
          'health-test'
        )
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const available = await Promise.race([
          app.$client`SELECT 42 AS answer`,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error('Health probes exhausted the shared pool')),
              1500
            )
          })
        ])
        assert.equal(available[0]!.answer, 42)
        const deadline = Date.now() + 1500
        for (;;) {
          const [activity] = await owner.$client`SELECT count(*)::int AS active
            FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()
            AND state = 'active' AND query ILIKE '%FROM films LIMIT 0%'`
          if (activity!.active === 0) break
          if (Date.now() > deadline)
            throw new Error('Health SQL outlived its deadline')
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      } finally {
        clearTimeout(timer)
      }
    } finally {
      await lock`ROLLBACK`
      lock.release()
    }
    assert.equal((await healthResponse()).status, 200)
    proxy.stall()
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => healthResponse())
    )
    for (const response of responses) {
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { ok: false })
    }
    proxy.allowNewConnections()
    assert.equal((await healthResponse()).status, 200)
    const deadline = Date.now() + 1000
    while (proxy.stalledConnections && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(proxy.stalledConnections, 0)
  } finally {
    proxy.release()
    await app.$client.end()
    await proxy.close()
    await owner.$client.end()
    await control.$client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await control.$client.end()
  }
})
