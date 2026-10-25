import '@tanstack/react-start/server-only'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg'
import type { AnnualFilm, Film, ImportedFilm } from '../lib/films.ts'
import { FilmError, completeOrder } from '../lib/validation.ts'
import { currentYear } from '../lib/years.ts'

// The same database-scoped transaction lock as the previous PostgreSQL release.
const watchlistLock = '6003385505269698370'
const migrationsDirectory = () => join(process.cwd(), 'src/migrations')
type Queryable = Pick<PoolClient, 'query'>

export function databaseConfig(databaseURL: string | undefined): PoolConfig {
  try {
    if (!databaseURL) throw new Error()
    const url = new URL(databaseURL)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.replace(/\//g, '')
    )
      throw new Error()
    return {
      connectionString: databaseURL,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 300000,
      maxLifetimeSeconds: 1800,
      application_name: 'spooktober',
      statement_timeout: 10000,
      lock_timeout: 5000,
      query_timeout: 12000,
      options: '-c timezone=UTC -c search_path=public'
    }
  } catch {
    throw new Error(
      'Set DATABASE_URL to a valid postgres:// or postgresql:// URL including the database name.'
    )
  }
}

export function createDatabase(databaseURL: string | undefined): Pool {
  const pool = new pg.Pool(databaseConfig(databaseURL))
  pool.on('error', () =>
    console.error(
      'Spooktober lost an idle PostgreSQL connection; it will reconnect on the next request.'
    )
  )
  return pool
}

const globals = globalThis as typeof globalThis & { spooktoberDatabase?: Pool }
export function database(): Pool {
  return (globals.spooktoberDatabase ??= createDatabase(
    process.env.DATABASE_URL
  ))
}

export async function migrationFiles() {
  const files = (await readdir(migrationsDirectory())).sort()
  if (
    !files.length ||
    files.some(
      (file, index) =>
        !/^\d{3}_.+\.sql$/.test(file) || Number(file.slice(0, 3)) !== index + 1
    )
  ) {
    throw new Error(
      'PostgreSQL migrations must have consecutive versions starting at 001.'
    )
  }
  return files
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  let unusable = false
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      watchlistLock
    ])
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      unusable = true
    }
    throw error
  } finally {
    client.release(unusable)
  }
}

export async function migrateDatabase(pool: Pool) {
  const files = await migrationFiles()
  await transaction(pool, async (client) => {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    const {
      rows: [history]
    } = await client.query(
      'SELECT COALESCE(MAX(version),0)::int AS version, COUNT(*)::int AS applied FROM schema_migrations'
    )
    if (history.version > files.length || history.applied !== history.version)
      throw new Error(
        'Database migration history is incompatible with this Spooktober version.'
      )
    for (let i = history.version; i < files.length; i++) {
      await client.query(
        await readFile(join(migrationsDirectory(), files[i]), 'utf8')
      )
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [i + 1]
      )
    }
  })
}

export async function readyDatabase(pool: Queryable) {
  const files = await migrationFiles()
  const {
    rows: [history]
  } =
    await pool.query(`SELECT COALESCE(MAX(version),0)::int AS version, COUNT(*)::int AS applied,
    EXISTS(SELECT 1 FROM films) AS has_films FROM schema_migrations`)
  if (history.version !== files.length || history.applied !== history.version)
    throw new Error(
      'PostgreSQL schema does not match this app; run db migrate before starting.'
    )
}

const roleName = /^[a-z_][a-z0-9_]{0,62}$/

// The app's login may only read and write the watchlist; it can neither alter
// migration history nor delete films. Run as the owner after every migration.
export async function grantRuntimeAccess(pool: Pool, role: string) {
  if (!roleName.test(role))
    throw new Error(
      'The runtime role must be a lower-case PostgreSQL role name.'
    )
  await readyDatabase(pool)
  const login = `"${role}"`
  await transaction(pool, async (client) => {
    await client.query(`GRANT USAGE ON SCHEMA public TO ${login};
      GRANT SELECT ON public.schema_migrations TO ${login};
      REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM ${login};
      GRANT SELECT, INSERT, UPDATE ON public.films TO ${login};
      REVOKE DELETE ON public.films FROM ${login}`)
    // GRANT only warns when the login lacks grant rights, so verify what the role can really do.
    const {
      rows: [effective]
    } = await client.query(
      `SELECT
      has_schema_privilege($1, 'public', 'USAGE') AND has_table_privilege($1, 'public.schema_migrations', 'SELECT')
      AND has_table_privilege($1, 'public.films', 'SELECT') AND has_table_privilege($1, 'public.films', 'INSERT')
      AND has_table_privilege($1, 'public.films', 'UPDATE') AND NOT has_table_privilege($1, 'public.films', 'DELETE')
      AND NOT has_table_privilege($1, 'public.schema_migrations', 'INSERT') AND NOT has_table_privilege($1, 'public.schema_migrations', 'UPDATE')
      AND NOT has_table_privilege($1, 'public.schema_migrations', 'DELETE') AS ok`,
      [role]
    )
    if (!effective.ok)
      throw new Error(
        'The runtime role does not have the intended privileges; run this as the schema owner.'
      )
  })
}

export async function listFilms(
  db: Queryable,
  year = currentYear()
): Promise<Film[]> {
  const { rows } = await db.query<Film>(
    `SELECT id,title,position,watched,watched_at AS "watchedAt",
    updated_at AS "updatedAt",created_at AS "createdAt" FROM films WHERE year=$1 ORDER BY position,id`,
    [year]
  )
  return rows
}

// Deployment snapshots must include historical and future seasons even when
// the current year's list is empty. Keep each season's viewing order.
export async function listAllFilms(db: Queryable): Promise<AnnualFilm[]> {
  const { rows } =
    await db.query<AnnualFilm>(`SELECT id,title,position,watched,year,watched_at AS "watchedAt",
    updated_at AS "updatedAt",created_at AS "createdAt" FROM films ORDER BY year,position,id`)
  return rows
}

async function changeFilms(
  pool: Pool,
  year: number,
  change: (client: PoolClient) => Promise<void>
): Promise<Film[]> {
  return transaction(pool, async (client) => {
    await change(client)
    return listFilms(client, year)
  })
}

export async function addFilm(
  pool: Pool,
  id: string,
  title: string,
  year = currentYear()
) {
  return changeFilms(pool, year, async (client) => {
    const {
      rows: [existing]
    } = await client.query('SELECT title,year FROM films WHERE id=$1', [id])
    if (existing) {
      if (existing.title !== title || existing.year !== year)
        throw new FilmError(
          'This film identifier has already been used. Please refresh.',
          409
        )
      return
    }
    const now = new Date().toISOString()
    await client.query(
      `INSERT INTO films (id,title,position,watched,created_at,updated_at,year)
      SELECT $1,$2,COALESCE(MAX(position)+1,0),false,$3,$3,$4 FROM films WHERE year=$4`,
      [id, title, now, year]
    )
  })
}

export async function markWatched(
  pool: Pool,
  id: string,
  watched: boolean,
  year = currentYear()
) {
  return changeFilms(pool, year, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE films SET watched_at=CASE
      WHEN NOT $1 THEN NULL WHEN NOT watched THEN $2 ELSE watched_at END,
      watched=$1,updated_at=$2 WHERE id=$3 AND year=$4`,
      [watched, new Date().toISOString(), id, year]
    )
    if (!rowCount)
      throw new FilmError(
        'That film is no longer on the list. Please refresh.',
        404
      )
  })
}

export async function reorderFilms(
  pool: Pool,
  requested: string[],
  year = currentYear()
) {
  return changeFilms(pool, year, async (client) => {
    const films = await listFilms(client, year)
    const ids = completeOrder(
      requested,
      films.map((film) => film.id)
    )
    const now = new Date().toISOString()
    for (const [position, id] of ids.entries())
      await client.query(
        'UPDATE films SET position=$1,updated_at=$2 WHERE id=$3 AND year=$4',
        [position, now, id, year]
      )
  })
}

export async function importFilms(
  pool: Pool,
  films: ImportedFilm[],
  year?: number
) {
  if (
    year !== undefined &&
    films.some((film) => film.year !== undefined && film.year !== year)
  ) {
    throw new Error(
      'The imported films do not all belong to the requested year.'
    )
  }
  const fallbackYear = year ?? currentYear()
  const years = films.length
    ? [...new Set(films.map((film) => film.year ?? fallbackYear))]
    : [fallbackYear]
  await readyDatabase(pool)
  await transaction(pool, async (client) => {
    const {
      rows: [existing]
    } = await client.query(
      'SELECT COUNT(*)::int AS count FROM films WHERE year=ANY($1::int[])',
      [years]
    )
    if (existing.count)
      throw new Error(
        'Seed/import requires empty target years; existing films were left unchanged.'
      )
    for (const film of films) {
      await client.query(
        `INSERT INTO films (id,title,position,watched,watched_at,created_at,updated_at,year)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          film.id,
          film.title,
          film.position,
          film.watched,
          film.watchedAt,
          film.createdAt,
          film.updatedAt,
          film.year ?? fallbackYear
        ]
      )
    }
  })
}
