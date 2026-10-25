import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  unique
} from 'drizzle-orm/pg-core'

export const films = pgTable(
  'films',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    watched: boolean('watched').notNull().default(false),
    // RFC3339 UTC text preserves nanoseconds in exports from the existing watchlist.
    watchedAt: text('watched_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    year: integer('year').notNull()
  },
  (table) => [
    check('films_id_check', sql`length(${table.id}) BETWEEN 1 AND 100`),
    check(
      'films_title_check',
      sql`length(trim(${table.title})) BETWEEN 1 AND 200`
    ),
    check('films_position_check', sql`${table.position} >= 0`),
    check('films_year_check', sql`${table.year} BETWEEN 1900 AND 9999`),
    check(
      'films_watched_date',
      sql`${table.watched} OR ${table.watchedAt} IS NULL`
    ),
    // DEFERRABLE INITIALLY DEFERRED in the migration, so reorders can swap positions.
    unique('films_position_unique').on(table.year, table.position)
  ]
)
