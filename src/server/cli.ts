import { join } from "node:path";
import { createDatabase, importFilms, listFilms, migrateDatabase, readyDatabase } from "./database.ts";
import { exportWatchlist, readWatchlist } from "./watchlist.ts";

async function run() {
  const [command, source, ...extra] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("Spooktober database commands: migrate | seed | import <path|-> | export <path|->");
    return;
  }
  if (!["migrate", "seed", "import", "export"].includes(command) || extra.length || (["import", "export"].includes(command) ? !source : !!source)) throw new Error("Use migrate, seed, import <path|-> or export <path|->.");
  const pool = createDatabase(process.env.DATABASE_URL);
  try {
    if (command === "migrate") await migrateDatabase(pool);
    else {
      await readyDatabase(pool);
      if (command === "export") await exportWatchlist(await listFilms(pool), source);
      else await importFilms(pool, await readWatchlist(command === "seed" ? join(process.cwd(), "src/seed.json") : source));
    }
  } finally { await pool.end(); }
}

run().catch(() => {
  // Connection errors can include private endpoints or credentials; keep output generic.
  console.error("Database command failed. Check the command, DATABASE_URL, schema permissions and input. Seed/import requires an empty database.");
  process.exitCode = 1;
});
