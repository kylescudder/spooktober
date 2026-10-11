import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTimestamp, parseWatchlist, exportWatchlist } from "./watchlist.ts";
import { databaseConfig } from "./database.ts";

const film = { id: "old-film", title: "  The Thing  ", position: 17, watched: true, watchedAt: null, updatedAt: "2026-10-05T12:30:00.123456789+01:00" };

test("imports preserve IDs, array order, unknown watched dates and timestamp nanoseconds", () => {
  const films = parseWatchlist(JSON.stringify({ films: [film] }));
  assert.equal(films[0].position, 0);
  assert.equal(films[0].title, "The Thing");
  assert.equal(films[0].watchedAt, null);
  assert.equal(films[0].updatedAt, "2026-10-05T11:30:00.123456789Z");
  assert.equal(films[0].createdAt, films[0].updatedAt);
  assert.equal(normalizeTimestamp("2026-10-05T00:00:00.120000000Z"), "2026-10-05T00:00:00.12Z");
  for (const date of ["2026-02-30T00:00:00Z", "2026-10-05T24:00:00Z", "2026-10-05T00:00:00.1234567890Z", "2026-10-05"]) assert.throws(() => normalizeTimestamp(date));
  for (const films of [[film, film], [{ ...film, watched: false, watchedAt: film.updatedAt }], [{ ...film, title: "bad\0title" }], [{ ...film, watched: "true" }]]) assert.throws(() => parseWatchlist(JSON.stringify({ films })));
  assert.throws(() => parseWatchlist("x".repeat(1024 * 1024 + 1)));
});

test("portable exports are private files and restore without data loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spooktober-export-"));
  try {
    const path = join(directory, "watchlist.json");
    const films = parseWatchlist(JSON.stringify({ films: [film] }));
    await exportWatchlist(films, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(parseWatchlist(await readFile(path)), films);
  } finally { await rm(directory, { recursive: true }); }
});

test("database URLs require PostgreSQL and a named database without echoing secrets", () => {
  assert.equal(databaseConfig("postgres://qa:private-password@localhost/spooktober").max, 4);
  for (const url of [undefined, "file:db.sqlite", "postgres://localhost/", "postgres://qa:private-password@[invalid/spooktober"]) {
    assert.throws(() => databaseConfig(url), (error: unknown) => error instanceof Error && !error.message.includes("private-password"));
  }
});
