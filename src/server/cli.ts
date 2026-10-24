import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createDatabase,
  grantRuntimeAccess,
  importFilms,
  listAllFilms,
  listFilms,
  migrateDatabase,
  readyDatabase
} from './database.ts'
import { exportWatchlist, readWatchlist } from './watchlist.ts'
import { currentYear, yearSchema } from '../lib/years.ts'

async function run() {
  const args = process.argv.slice(2)
  const yearIndex = args.indexOf('--year')
  const year =
    yearIndex < 0
      ? undefined
      : yearSchema.parse(Number(args.splice(yearIndex, 2)[1]))
  const [command, source, ...extra] = args
  if (!command || command === 'help' || command === '--help') {
    console.log(
      'Spooktober database commands: migrate | grant <runtime-role> | seed [--year YYYY] | import <path|-> [--year YYYY] | export <path|-> [--year YYYY]'
    )
    return
  }
  if (
    !['migrate', 'grant', 'seed', 'import', 'export'].includes(command) ||
    extra.length ||
    (['grant', 'import', 'export'].includes(command) ? !source : !!source)
  )
    throw new Error(
      'Use migrate, grant <runtime-role>, seed, import <path|-> or export <path|->.'
    )
  if (yearIndex >= 0 && ['migrate', 'grant'].includes(command))
    throw new Error('Only seed/import/export accept --year.')
  const pool = createDatabase(process.env.DATABASE_URL)
  try {
    if (command === 'migrate') await migrateDatabase(pool)
    else if (command === 'grant') await grantRuntimeAccess(pool, source)
    else {
      await readyDatabase(pool)
      if (command === 'export')
        await exportWatchlist(
          year === undefined
            ? await listAllFilms(pool)
            : await listFilms(pool, year),
          source
        )
      else {
        const films = await readWatchlist(
          command === 'seed' ? join(process.cwd(), 'src/seed.json') : source
        )
        // Supplied seed IDs belong to 2026; allow the template in later seasons.
        if (command === 'seed' && (year ?? currentYear()) !== 2026)
          for (const film of films) film.id = randomUUID()
        await importFilms(pool, films, year)
      }
    }
  } finally {
    await pool.end()
  }
}

run().catch(() => {
  // Connection errors can include private endpoints or credentials; keep output generic.
  console.error(
    'Database command failed. Check the command, year, DATABASE_URL, schema permissions and input. Seed/import requires an empty year and unused film IDs.'
  )
  process.exitCode = 1
})
