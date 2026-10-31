import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import {
  addFilm,
  databaseConfig,
  createDatabase,
  type Database,
  grantRuntimeAccess,
  importFilms,
  listFilms,
  markWatched,
  migrateDatabase,
  editFilm,
  removeFilm,
  reorderFilms
} from './database.ts'
import { normalizeTimestamp, parseWatchlist } from './watchlist.ts'
import { createTrpcHandler } from './trpc-handler.ts'
import type { AppRouter } from './trpc.ts'

async function testDatabase(t: TestContext) {
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
  const pool = createDatabase(url.href)
  const cleanup: Array<() => Promise<void>> = []
  t.after(async () => {
    for (const close of cleanup.reverse()) await close()
    await pool.$client.end()
    await control.$client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await control.$client.end()
  })
  return { pool, url, control, cleanup }
}

const seed = async () => parseWatchlist(await readFile('src/seed.json'))

test('database clients retain bounded connection and session safeguards', async (t) => {
  const { pool, url } = await testDatabase(t)
  const options = databaseConfig(url.href)
  assert.equal(options.max, 4)
  assert.equal(options.connect_timeout, 10)
  assert.equal(options.idle_timeout, 20)
  assert.equal(options.max_lifetime, 1800)
  const [settings] = await pool.$client`SELECT
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout,
    current_setting('TimeZone') AS timezone,
    current_setting('search_path') AS search_path`
  assert.deepEqual(
    { ...settings },
    {
      statement_timeout: '10s',
      lock_timeout: '5s',
      timezone: 'UTC',
      search_path: 'public'
    }
  )
})

test(
  'idle application connections retire and reconnect without losing annual films',
  { timeout: 30000 },
  async (t) => {
    const { pool, control } = await testDatabase(t)
    await migrateDatabase(pool)
    const id = randomUUID()
    await addFilm(pool, id, 'Halloween', 2026)
    await markWatched(pool, id, true, 2026)
    const before = await listFilms(pool, 2026)
    const [backend] = await pool.$client`SELECT pg_backend_pid() AS pid`
    const started = Date.now()
    const deadline = started + 25000
    // Observe from a separate client: querying the app would restart its idle timer.
    for (;;) {
      const [activity] = await control.$client`SELECT count(*)::int AS connected
      FROM pg_stat_activity WHERE pid = ${backend!.pid}`
      if (activity!.connected === 0) break
      assert.ok(
        Date.now() < deadline,
        'The application connection must retire after 20 idle seconds'
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(
      Date.now() - started >= 19000,
      'Do not retire idle application connections early'
    )
    assert.deepEqual(await listFilms(pool, 2026), before)
    assert.deepEqual(await listFilms(pool, 2027), [])
    const [reconnected] = await pool.$client`SELECT pg_backend_pid() AS pid`
    assert.notEqual(reconnected!.pid, backend!.pid)
  }
)

test('deployment CLI exports and restores every season when the current year is empty', async (t) => {
  const { pool, url } = await testDatabase(t)
  await migrateDatabase(pool)
  const films = parseWatchlist(
    JSON.stringify({
      films: [
        {
          id: 'historical-1',
          title: 'Halloween',
          watched: true,
          watchedAt: '2020-10-31T23:00:00.123456789Z',
          updatedAt: '2020-10-31T23:00:00.123456789Z'
        },
        {
          id: 'historical-2',
          title: 'The Thing',
          watched: false,
          updatedAt: '2020-10-01T12:00:00Z'
        }
      ]
    })
  )
  await importFilms(pool, films, 2020)
  // Reproduce timestamps whose millisecond representation ends in zero.
  const timestamp = t.mock.method(
    Date.prototype,
    'toISOString',
    () => '2021-10-01T12:00:00.900Z'
  )
  await addFilm(pool, randomUUID(), 'Alien', 2021)
  timestamp.mock.restore()
  assert.deepEqual(await listFilms(pool), [])
  const cli = (databaseURL: URL, args: string[], input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['src/server/cli.ts', ...args],
        {
          env: { ...process.env, DATABASE_URL: databaseURL.href }
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
      child.stdin!.end(input)
    })
  const snapshot = await cli(url, ['export', '-'])
  const backup = JSON.parse(snapshot)
  assert.deepEqual(
    backup.films.map(({ year, title }: { year: number; title: string }) => [
      year,
      title
    ]),
    [
      [2020, 'Halloween'],
      [2020, 'The Thing'],
      [2021, 'Alien']
    ]
  )
  const { pool: restored, url: restoredURL } = await testDatabase(t)
  await migrateDatabase(restored)
  await cli(restoredURL, ['import', '-'], snapshot)
  for (const year of [2020, 2021])
    assert.deepEqual(
      await listFilms(restored, year),
      // Imports canonicalize equivalent timestamp spellings without losing precision.
      (await listFilms(pool, year)).map((film) => ({
        ...film,
        createdAt: normalizeTimestamp(film.createdAt),
        updatedAt: normalizeTimestamp(film.updatedAt),
        watchedAt:
          film.watchedAt === null ? null : normalizeTimestamp(film.watchedAt)
      }))
    )
  assert.deepEqual(await listFilms(restored), [])
  await assert.rejects(cli(restoredURL, ['import', '-'], snapshot))
  await assert.rejects(
    cli(restoredURL, ['import', '-', '--year', '2022'], snapshot)
  )
  assert.deepEqual(await listFilms(restored, 2022), [])
  const single = JSON.parse(await cli(url, ['export', '-', '--year', '2020']))
  assert.deepEqual(single.films, await listFilms(pool, 2020))
})

test('a late conflict in a multi-season restore rolls back every inserted season', async (t) => {
  const { pool } = await testDatabase(t)
  await migrateDatabase(pool)
  const existing = parseWatchlist(
    JSON.stringify({
      films: [{ id: 'already-present', title: 'Alien', watched: false }]
    })
  )
  await importFilms(pool, existing, 2019)
  const snapshot = parseWatchlist(
    JSON.stringify({
      films: [
        { id: 'first-season', title: 'Halloween', watched: false, year: 2020 },
        { id: 'already-present', title: 'Alien', watched: false, year: 2021 }
      ]
    })
  )
  await assert.rejects(importFilms(pool, snapshot))
  assert.deepEqual(await listFilms(pool, 2020), [])
  assert.deepEqual(await listFilms(pool, 2021), [])
  assert.deepEqual(await listFilms(pool, 2019), existing)
})

test('annual lists keep additions, watched progress and order separate', async (t) => {
  const { pool } = await testDatabase(t)
  await migrateDatabase(pool)
  await importFilms(pool, await seed(), 2026)
  const original = await listFilms(pool, 2026)
  assert.deepEqual(await listFilms(pool, 2027), [])
  const first = randomUUID(),
    second = randomUUID()
  await addFilm(pool, first, 'The Thing', 2027)
  await addFilm(pool, second, 'Alien', 2027)
  await markWatched(pool, first, true, 2027)
  await reorderFilms(pool, [second, first], 2027)
  const nextYear = await listFilms(pool, 2027)
  assert.deepEqual(
    nextYear.map(({ title, watched, position }) => ({
      title,
      watched,
      position
    })),
    [
      { title: 'Alien', watched: false, position: 0 },
      { title: 'The Thing', watched: true, position: 1 }
    ]
  )
  await assert.rejects(markWatched(pool, 'film-01', true, 2027), {
    status: 404
  })
  await assert.rejects(reorderFilms(pool, ['film-01'], 2027), { status: 409 })
  await assert.rejects(addFilm(pool, first, 'The Thing', 2026), { status: 409 })
  assert.deepEqual(await listFilms(pool, 2026), original)
  assert.deepEqual(await listFilms(pool, 2027), nextYear)
})

test('migrations are repeatable and record one baseline', async (t) => {
  const { pool } = await testDatabase(t)
  await migrateDatabase(pool)
  await migrateDatabase(pool)
  assert.deepEqual(await listFilms(pool), [])
  const [journal] = await pool.$client`
    SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`
  assert.equal(journal!.applied, 1)
})

test('the baseline adopts a database from the pre-Drizzle migrations', async (t) => {
  const { pool } = await testDatabase(t)
  await pool.$client.unsafe(
    await readFile('src/server/fixtures/legacy-schema.sql', 'utf8')
  )
  await pool.$client`INSERT INTO films (id,title,position,watched,watched_at,created_at,updated_at,year)
    VALUES ('legacy', 'Halloween', 0, true, '2026-10-31T23:00:00.123456789Z', '2026-10-01T12:00:00Z', '2026-10-31T23:00:00Z', 2026)`
  const before = await listFilms(pool, 2026)
  await migrateDatabase(pool)
  await migrateDatabase(pool)
  assert.deepEqual(await listFilms(pool, 2026), before)
  assert.equal(before[0]!.watchedAt, '2026-10-31T23:00:00.123456789Z')
  // The previous release still reads its history after a rollback.
  const [history] = await pool.$client`
    SELECT max(version)::int AS version FROM schema_migrations`
  assert.equal(history!.version, 2)
  // Constraints, including the deferrable unique position, behave as before.
  await reorderFilms(pool, ['legacy'], 2026)
  await assert.rejects(
    pool.$client`INSERT INTO films (id,title,position,created_at,updated_at,year)
      VALUES ('dup', 'Alien', 0, 'now', 'now', 2026)`
  )
})

test('the baseline refuses a database that predates annual watchlists', async (t) => {
  const { pool } = await testDatabase(t)
  const legacy = await readFile('src/server/fixtures/legacy-schema.sql', 'utf8')
  await pool.$client.unsafe(legacy.slice(0, legacy.indexOf('-- The original')))
  await assert.rejects(migrateDatabase(pool), /predates annual watchlists/)
})

test('watched dates, idempotent adds and stale reorders preserve the list', async (t) => {
  const { pool } = await testDatabase(t)
  await migrateDatabase(pool)
  await importFilms(pool, await seed())
  let films = await markWatched(pool, 'film-06', true)
  assert.equal(films[5].watchedAt, null)
  films = await markWatched(pool, 'film-01', true)
  const date = films[0].watchedAt
  assert.ok(date)
  assert.equal((await markWatched(pool, 'film-01', true))[0].watchedAt, date)
  const id = randomUUID()
  await addFilm(pool, id, 'The Thing')
  await addFilm(pool, id, 'The Thing')
  await assert.rejects(addFilm(pool, id, 'Another film'), { status: 409 })
  films = await reorderFilms(pool, ['film-02', 'film-01'])
  assert.equal(films.length, 21)
  assert.deepEqual(
    films.slice(0, 2).map((film) => film.id),
    ['film-02', 'film-01']
  )
  assert.equal(films.at(-1)?.id, id)
  assert.equal(
    (await markWatched(pool, 'film-01', false)).find(
      (film) => film.id === 'film-01'
    )?.watchedAt,
    null
  )
  await assert.rejects(markWatched(pool, 'missing', true), { status: 404 })
})

test('independent connection pools retain all simultaneous adds, ticks and reorders', async (t) => {
  const { pool, url, cleanup } = await testDatabase(t)
  await migrateDatabase(pool)
  await importFilms(pool, await seed())
  const other = createDatabase(url.href)
  cleanup.push(() => other.$client.end())
  const pools = [pool, other]
  await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      await Promise.all([
        addFilm(pools[i % 2], randomUUID(), `Concurrent film ${i}`),
        reorderFilms(pools[(i + 1) % 2], ['film-02', 'film-01']),
        markWatched(pools[i % 2], 'film-01', true)
      ])
    })
  )
  const films = await listFilms(other)
  assert.equal(films.length, 32)
  assert.equal(new Set(films.map((film) => film.id)).size, 32)
  assert.deepEqual(
    films.map((film) => film.position),
    Array.from({ length: 32 }, (_, i) => i)
  )
  assert.equal(films.find((film) => film.id === 'film-01')?.watched, true)
})

test('JSON restore preserves nanoseconds, refuses overwrite and rolls back partial inserts', async (t) => {
  const { pool } = await testDatabase(t)
  await migrateDatabase(pool)
  const films = parseWatchlist(
    JSON.stringify({
      films: [
        {
          id: 'from-old-release',
          title: 'The Thing',
          watched: true,
          watchedAt: null,
          updatedAt: '2026-10-05T10:30:00.123456789Z'
        }
      ]
    })
  )
  await importFilms(pool, films)
  assert.deepEqual(await listFilms(pool), films)
  await assert.rejects(importFilms(pool, films))
  const { pool: copy } = await testDatabase(t)
  await migrateDatabase(copy)
  await importFilms(
    copy,
    parseWatchlist(JSON.stringify({ films: await listFilms(pool) }))
  )
  assert.deepEqual(await listFilms(copy), films)
  const { pool: clean } = await testDatabase(t)
  await migrateDatabase(clean)
  await assert.rejects(
    importFilms(clean, [films[0], { ...films[0], id: 'second', title: ' ' }])
  )
  assert.deepEqual(await listFilms(clean), [])
})

test('edits and removals coordinate across pools without resurrecting films or losing additions', async (t) => {
  const { pool, url, cleanup } = await testDatabase(t)
  await migrateDatabase(pool)
  const other = createDatabase(url.href)
  cleanup.push(() => other.$client.end())
  const year = 2040
  const first = randomUUID(),
    second = randomUUID(),
    third = randomUUID()
  await addFilm(pool, first, 'Halloween', year)
  await addFilm(pool, second, 'Alien', year)
  await markWatched(pool, second, true, year)
  const original = await listFilms(pool, year)
  await Promise.all([
    removeFilm(pool, first, year),
    editFilm(other, second, 'Alien (1979)', year),
    addFilm(other, third, 'The Thing', year),
    markWatched(pool, second, true, year)
  ])
  const result = await listFilms(other, year)
  assert.deepEqual(
    result.map(({ title, position, watched }) => ({
      title,
      position,
      watched
    })),
    [
      { title: 'Alien (1979)', position: 0, watched: true },
      { title: 'The Thing', position: 1, watched: false }
    ]
  )
  assert.equal(result[0].watchedAt, original[1].watchedAt)
  assert.equal(result[0].createdAt, original[1].createdAt)
  await assert.rejects(reorderFilms(pool, [first, second], year), {
    status: 409
  })
  await assert.rejects(editFilm(pool, first, 'Deleted film', year), {
    status: 404
  })
  assert.deepEqual(await removeFilm(pool, first, year), result)
  assert.deepEqual(await listFilms(other, year), result)
})

test('tRPC transport validates inputs, requires auth and rejects unsafe requests', async (t) => {
  const { pool, url, cleanup } = await testDatabase(t)
  await migrateDatabase(pool)
  await importFilms(pool, await seed())
  const globals = globalThis as typeof globalThis & {
    spooktoberDatabase?: Database
  }
  const previous = { ...process.env }
  process.env.DATABASE_URL = url.href
  process.env.CLERK_ALLOWED_USER_IDS = 'user_Kyle,user_Rhiann'
  process.env.PUBLIC_URL = 'https://films.example.com'
  globals.spooktoberDatabase = pool
  cleanup.push(async () => {
    delete globals.spooktoberDatabase
    process.env = previous
  })
  let userId: string | null = 'user_Kyle'
  const trpcHandler = createTrpcHandler(async () => userId)
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'http://localhost/api/trpc',
        headers: {
          origin: 'https://films.example.com',
          'x-spooktober-request': '1'
        },
        fetch: (url, options) =>
          trpcHandler(new Request(url, options as RequestInit))
      })
    ]
  })
  assert.equal((await client.films.list.query()).length, 20)
  const id = randomUUID()
  assert.equal(
    (
      await client.films.add.mutate({
        id,
        title: ' The Thing ',
        year: new Date().getFullYear()
      })
    ).at(-1)?.title,
    'The Thing'
  )
  assert.equal(
    (
      await client.films.setWatched.mutate({
        id,
        watched: true,
        year: new Date().getFullYear()
      })
    ).at(-1)?.watched,
    true
  )
  assert.equal(
    (
      await client.films.reorder.mutate({
        ids: [id],
        year: new Date().getFullYear()
      })
    )[0].id,
    id
  )
  await assert.rejects(
    client.films.add.mutate({
      id: randomUUID(),
      title: ' ',
      year: new Date().getFullYear()
    }),
    /Enter a film title/
  )
  const beforeEdit = (await client.films.list.query())[0]
  const edited = await client.films.edit.mutate({
    id,
    title: ' The Thing (1982) ',
    year: new Date().getFullYear()
  })
  assert.deepEqual(edited[0], {
    ...beforeEdit,
    title: 'The Thing (1982)',
    updatedAt: edited[0].updatedAt
  })
  assert.deepEqual(await client.films.list.query(), edited)
  for (const title of [' ', 'x'.repeat(201), 'bad\0title'])
    await assert.rejects(
      client.films.edit.mutate({ id, title, year: new Date().getFullYear() }),
      /Enter a film title/
    )
  await assert.rejects(
    client.films.reorder.mutate({
      ids: [id, id],
      year: new Date().getFullYear()
    }),
    /Each film must appear once/
  )
  const nextYear = new Date().getFullYear() + 1
  assert.deepEqual(await client.films.list.query({ year: nextYear }), [])
  await client.films.add.mutate({
    id: randomUUID(),
    title: 'Next season',
    year: nextYear
  })
  assert.equal(
    (await client.films.list.query({ year: nextYear }))[0].title,
    'Next season'
  )
  await assert.rejects(
    client.films.setWatched.mutate({ id, watched: true, year: nextYear }),
    /no longer on the list/
  )
  await assert.rejects(
    client.films.edit.mutate({ id, title: 'Wrong year', year: nextYear }),
    /no longer on the list/
  )
  await client.films.remove.mutate({ id, year: nextYear })
  assert.equal((await client.films.list.query())[0].title, 'The Thing (1982)')
  await assert.rejects(
    client.films.reorder.mutate({ ids: [id], year: nextYear }),
    /list has changed/
  )
  await assert.rejects(client.films.list.query({ year: 2026.5 }))
  await assert.rejects(
    client.films.add.mutate({
      id: randomUUID(),
      title: 'Invalid season',
      year: 10000
    })
  )
  const beforeDenied = await listFilms(pool)
  userId = null
  for (const user of [null, 'user_SomeoneElse']) {
    userId = user
    await assert.rejects(
      client.films.edit.mutate({
        id,
        title: 'Forbidden',
        year: new Date().getFullYear()
      }),
      (error: unknown) =>
        (error as { meta?: { response?: Response } }).meta?.response?.status ===
        (user === null ? 401 : 403)
    )
    await assert.rejects(
      client.films.remove.mutate({ id, year: new Date().getFullYear() }),
      (error: unknown) =>
        (error as { meta?: { response?: Response } }).meta?.response?.status ===
        (user === null ? 401 : 403)
    )
  }
  userId = null
  const denied = await trpcHandler(
    new Request('http://localhost/api/trpc/films.list', {
      headers: {
        'x-user-id': 'user_Kyle',
        'x-clerk-auth-status': 'signed-in',
        'x-clerk-auth-user-id': 'user_Kyle'
      }
    })
  )
  assert.equal(denied.status, 401)
  assert.match(denied.headers.get('cache-control')!, /no-store/)
  assert.equal(denied.headers.get('www-authenticate'), null)
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/trpc/films.add', {
      method: 'POST',
      headers: {
        origin: 'https://films.example.com',
        'x-spooktober-request': '1',
        'content-type': 'application/json',
        ...headers
      },
      body
    })
  assert.equal((await trpcHandler(post('{}'))).status, 401)
  userId = 'user_SomeoneElse'
  assert.equal(
    (await trpcHandler(new Request('http://localhost/api/trpc/films.list')))
      .status,
    403
  )
  assert.equal((await trpcHandler(post('{}'))).status, 403)
  assert.deepEqual(await listFilms(pool), beforeDenied)
  userId = 'user_Rhiann'
  assert.equal((await client.films.list.query()).length, 21)
  assert.equal(
    (await trpcHandler(post('{}', { origin: 'https://elsewhere.example' })))
      .status,
    403
  )
  assert.equal(
    (await trpcHandler(post('{}', { 'content-type': 'text/plain' }))).status,
    415
  )
  assert.equal((await trpcHandler(post('{'))).status, 400)
  assert.equal((await trpcHandler(post('x'.repeat(17000)))).status, 413)
  const year = new Date().getFullYear()
  const removed = await client.films.remove.mutate({ id, year })
  assert.equal(removed.length, 20)
  assert.ok(removed.every((film) => film.id !== id))
  assert.deepEqual(
    removed.map((film) => film.position),
    Array.from({ length: 20 }, (_, i) => i)
  )
  assert.deepEqual(await client.films.remove.mutate({ id, year }), removed)
  assert.deepEqual(await client.films.list.query(), removed)
  await assert.rejects(
    client.films.edit.mutate({ id, title: 'Gone', year }),
    /no longer on the list/
  )
  assert.equal((await client.films.list.query({ year: nextYear })).length, 1)
})

test('a restricted runtime role can save films but cannot create schema or alter migration history', async (t) => {
  const { pool, url, control, cleanup } = await testDatabase(t)
  await migrateDatabase(pool)
  await importFilms(pool, await seed())
  const role = `spooktober_role_${randomUUID().replaceAll('-', '')}`
  await control.$client.unsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD 'local-runtime-only'`
  )
  await pool.$client.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
  await grantRuntimeAccess(pool, role)
  await grantRuntimeAccess(pool, role)
  url.username = role
  url.password = 'local-runtime-only'
  const runtime = createDatabase(url.href)
  cleanup.push(async () => {
    await runtime.$client.end()
    await pool.$client.unsafe(`DROP OWNED BY "${role}"`)
    await control.$client.unsafe(`DROP ROLE "${role}"`)
  })
  const id = randomUUID()
  await addFilm(runtime, id, 'Runtime film')
  await markWatched(runtime, id, true)
  await reorderFilms(runtime, [id])
  const edited = await editFilm(runtime, id, 'Renamed runtime film')
  assert.equal(edited[0].title, 'Renamed runtime film')
  const removed = await removeFilm(runtime, id)
  assert.equal(removed.length, 20)
  assert.ok(removed.every((film) => film.id !== id))
  await assert.rejects(
    runtime.$client.unsafe('CREATE TABLE forbidden (id integer)')
  )
  await assert.rejects(
    runtime.$client.unsafe('SELECT hash FROM drizzle.__drizzle_migrations')
  )
  await assert.rejects(migrateDatabase(runtime))
})

test('runtime grants reject unsafe role names and unmigrated databases', async (t) => {
  const { pool } = await testDatabase(t)
  await assert.rejects(grantRuntimeAccess(pool, 'spooktober_runtime'))
  await migrateDatabase(pool)
  for (const role of ['x"; DROP TABLE films; --', 'Mixed', '', 'a'.repeat(64)])
    await assert.rejects(grantRuntimeAccess(pool, role), /role name/)
  await assert.rejects(grantRuntimeAccess(pool, 'spooktober_missing_role'))
})
