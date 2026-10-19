import { join } from "node:path";
import { createDatabase, grantRuntimeAccess, importFilms, listFilms, migrateDatabase, readyDatabase } from "./database.ts";
import { exportWatchlist, readWatchlist } from "./watchlist.ts";

async function run() {
  const [command, source, ...extra] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("Spooktober database commands: migrate | grant <runtime-role> | seed | import <path|-> | export <path|->");
    return;
  }
  if (!["migrate", "grant", "seed", "import", "export"].includes(command) || extra.length || (["grant", "import", "export"].includes(command) ? !source : !!source)) throw new Error("Use migrate, grant <runtime-role>, seed, import <path|-> or export <path|->.");
  const pool = createDatabase(process.env.DATABASE_URL);
  try {
    if (command === "migrate") await migrateDatabase(pool);
    else if (command === "grant") await grantRuntimeAccess(pool, source);
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
