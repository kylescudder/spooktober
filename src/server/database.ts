import '@tanstack/react-start/server-only'
import { join } from 'node:path'
import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { readDatabaseEnv } from './env'
import type { AnnualFilm, Film, ImportedFilm } from '../lib/films.ts'
import { FilmError, completeOrder } from '../lib/validation.ts'
import { currentYear } from '../lib/years.ts'
import * as schema from './schema.ts'
import { films } from './schema.ts'

// The same database-scoped transaction lock as the previous PostgreSQL release.
const watchlistLock = '6003385505269698370'
const migrationsFolder = () => join(process.cwd(), 'drizzle')

export type Database = PostgresJsDatabase<typeof schema> & {
  $client: postgres.Sql
}
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Queryable = Database | Transaction

export function databaseConfig(
  databaseURL: string | undefined,
  max = 4
): postgres.Options<Record<string, never>> & { url: string } {
  try {
    const { DATABASE_URL } = readDatabaseEnv({ DATABASE_URL: databaseURL })
    return {
      url: DATABASE_URL,
      max,
      connect_timeout: 10,
      idle_timeout: 20,
      max_lifetime: 1800,
      onnotice: () => {},
      connection: {
        application_name: 'spooktober',
        statement_timeout: 10000,
        lock_timeout: 5000,
        TimeZone: 'UTC',
        search_path: 'public'
      }
    }
  } catch {
    throw new Error(
      'Set DATABASE_URL to a valid postgres:// or postgresql:// URL including the database name.'
    )
  }
}

export function createDatabase(
  databaseURL: string | undefined,
  max = 4
): Database {
  const { url, ...options } = databaseConfig(databaseURL, max)
  return drizzle(postgres(url, options), { schema })
}

const globals = globalThis as typeof globalThis & {
  spooktoberDatabase?: Database
}
export function database(): Database {
  return (globals.spooktoberDatabase ??= createDatabase(
    process.env.DATABASE_URL
  ))
}

async function transaction<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${watchlistLock}::bigint)`
      )
      return work(tx)
    },
    { isolationLevel: 'read committed' }
  )
}

// Runs with the owner role only. The journal lives in its own schema, which the
// runtime role cannot read or change.
export async function migrateDatabase(db: Database) {
  await migrate(db, {
    migrationsFolder: migrationsFolder(),
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations'
  })
}

const roleName = /^[a-z_][a-z0-9_]{0,62}$/

// The app's login may only read and write the watchlist; it can neither see
// migration history or change schema. Run as the owner after every migration.
export async function grantRuntimeAccess(db: Database, role: string) {
  if (!roleName.test(role))
    throw new Error(
      'The runtime role must be a lower-case PostgreSQL role name.'
    )
  const login = sql.identifier(role)
  await transaction(db, async (tx) => {
    const [tables] = await tx.execute<{
      films: boolean
      legacy: boolean
      journal: boolean
    }>(sql`SELECT to_regclass('public.films') IS NOT NULL AS films,
      to_regclass('public.schema_migrations') IS NOT NULL AS legacy,
      to_regnamespace('drizzle') IS NOT NULL AS journal`)
    if (!tables!.films)
      throw new Error('Run db migrate before granting runtime access.')
    await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ${login}`)
    await tx.execute(
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON public.films TO ${login}`
    )
    if (tables!.journal)
      await tx.execute(sql`REVOKE ALL ON SCHEMA drizzle FROM ${login}`)
    // The previous release reads its history table; keep that read-only grant
    // so a rollback to it still starts. Fresh databases don't have the table.
    if (tables!.legacy) {
      await tx.execute(
        sql`GRANT SELECT ON public.schema_migrations TO ${login}`
      )
      await tx.execute(
        sql`REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM ${login}`
      )
    }
    // GRANT only warns when the login lacks grant rights, so verify what the role can really do.
    const [effective] = await tx.execute<{ ok: boolean }>(sql`SELECT
      has_schema_privilege(${role}, 'public', 'USAGE')
      AND has_table_privilege(${role}, 'public.films', 'SELECT')
      AND has_table_privilege(${role}, 'public.films', 'INSERT')
      AND has_table_privilege(${role}, 'public.films', 'UPDATE')
      AND has_table_privilege(${role}, 'public.films', 'DELETE')
      AND (to_regnamespace('drizzle') IS NULL OR NOT has_schema_privilege(${role}, 'drizzle', 'USAGE'))
      AND (to_regclass('public.schema_migrations') IS NULL OR (
        has_table_privilege(${role}, 'public.schema_migrations', 'SELECT')
        AND NOT has_table_privilege(${role}, 'public.schema_migrations', 'INSERT')
        AND NOT has_table_privilege(${role}, 'public.schema_migrations', 'UPDATE')
        AND NOT has_table_privilege(${role}, 'public.schema_migrations', 'DELETE'))) AS ok`)
    if (!effective!.ok)
      throw new Error(
        'The runtime role does not have the intended privileges; run this as the schema owner.'
      )
  })
}

const filmColumns = {
  id: films.id,
  title: films.title,
  position: films.position,
  watched: films.watched,
  watchedAt: films.watchedAt,
  updatedAt: films.updatedAt,
  createdAt: films.createdAt
}

export async function listFilms(
  db: Queryable,
  year = currentYear()
): Promise<Film[]> {
  return db
    .select(filmColumns)
    .from(films)
    .where(eq(films.year, year))
    .orderBy(asc(films.position), asc(films.id))
}

// Deployment snapshots must include historical and future seasons even when
// the current year's list is empty. Keep each season's viewing order.
export async function listAllFilms(db: Queryable): Promise<AnnualFilm[]> {
  return db
    .select({ ...filmColumns, year: films.year })
    .from(films)
    .orderBy(asc(films.year), asc(films.position), asc(films.id))
}

async function changeFilms(
  db: Database,
  year: number,
  change: (tx: Transaction) => Promise<void>
): Promise<Film[]> {
  return transaction(db, async (tx) => {
    await change(tx)
    return listFilms(tx, year)
  })
}

export async function addFilm(
  db: Database,
  id: string,
  title: string,
  year = currentYear()
) {
  return changeFilms(db, year, async (tx) => {
    const [existing] = await tx
      .select({ title: films.title, year: films.year })
      .from(films)
      .where(eq(films.id, id))
    if (existing) {
      if (existing.title !== title || existing.year !== year)
        throw new FilmError(
          'This film identifier has already been used. Please refresh.',
          409
        )
      return
    }
    const now = new Date().toISOString()
    const [next] = await tx
      .select({
        position: sql<number>`COALESCE(${max(films.position)} + 1, 0)`
      })
      .from(films)
      .where(eq(films.year, year))
    await tx.insert(films).values({
      id,
      title,
      position: next!.position,
      watched: false,
      createdAt: now,
      updatedAt: now,
      year
    })
  })
}

export async function markWatched(
  db: Database,
  id: string,
  watched: boolean,
  year = currentYear()
) {
  return changeFilms(db, year, async (tx) => {
    const now = new Date().toISOString()
    const updated = await tx
      .update(films)
      .set({
        watchedAt: watched
          ? sql`CASE WHEN ${films.watched} THEN ${films.watchedAt} ELSE ${now} END`
          : null,
        watched,
        updatedAt: now
      })
      .where(and(eq(films.id, id), eq(films.year, year)))
      .returning({ id: films.id })
    if (!updated.length)
      throw new FilmError(
        'That film is no longer on the list. Please refresh.',
        404
      )
  })
}

export async function editFilm(
  db: Database,
  id: string,
  title: string,
  year = currentYear()
) {
  return changeFilms(db, year, async (tx) => {
    const updated = await tx
      .update(films)
      .set({ title, updatedAt: new Date().toISOString() })
      .where(and(eq(films.id, id), eq(films.year, year)))
      .returning({ id: films.id })
    if (!updated.length)
      throw new FilmError(
        'That film is no longer on the list. Please refresh.',
        404
      )
  })
}

export async function reorderFilms(
  db: Database,
  requested: string[],
  year = currentYear()
) {
  return changeFilms(db, year, async (tx) => {
    const current = await listFilms(tx, year)
    const ids = completeOrder(
      requested,
      current.map((film) => film.id)
    )
    const now = new Date().toISOString()
    for (const [position, id] of ids.entries())
      await tx
        .update(films)
        .set({ position, updatedAt: now })
        .where(and(eq(films.id, id), eq(films.year, year)))
  })
}

export async function removeFilm(
  db: Database,
  id: string,
  year = currentYear()
) {
  return changeFilms(db, year, async (tx) => {
    const removed = await tx
      .delete(films)
      .where(and(eq(films.id, id), eq(films.year, year)))
      .returning({ id: films.id })
    // A retry after a lost response must succeed without removing another film.
    if (!removed.length) return
    const remaining = await listFilms(tx, year)
    const now = new Date().toISOString()
    for (const [position, film] of remaining.entries()) {
      if (film.position === position) continue
      await tx
        .update(films)
        .set({ position, updatedAt: now })
        .where(and(eq(films.id, film.id), eq(films.year, year)))
    }
  })
}

export async function importFilms(
  db: Database,
  imported: ImportedFilm[],
  year?: number
) {
  if (
    year !== undefined &&
    imported.some((film) => film.year !== undefined && film.year !== year)
  ) {
    throw new Error(
      'The imported films do not all belong to the requested year.'
    )
  }
  const fallbackYear = year ?? currentYear()
  const years = imported.length
    ? [...new Set(imported.map((film) => film.year ?? fallbackYear))]
    : [fallbackYear]
  await transaction(db, async (tx) => {
    const [existing] = await tx
      .select({ count: count() })
      .from(films)
      .where(inArray(films.year, years))
    if (existing!.count)
      throw new Error(
        'Seed/import requires empty target years; existing films were left unchanged.'
      )
    for (const film of imported) {
      // Parsed watchlists always carry one; anything else would violate NOT NULL.
      if (film.createdAt === undefined)
        throw new Error('Imported films need a creation time.')
      await tx.insert(films).values({
        id: film.id,
        title: film.title,
        position: film.position,
        watched: film.watched,
        watchedAt: film.watchedAt,
        createdAt: film.createdAt,
        updatedAt: film.updatedAt,
        year: film.year ?? fallbackYear
      })
    }
  })
}
