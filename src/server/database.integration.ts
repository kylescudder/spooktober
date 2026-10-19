import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { Pool } from "pg";
import { addFilm, createDatabase, grantRuntimeAccess, importFilms, listFilms, markWatched, migrateDatabase, readyDatabase, reorderFilms } from "./database.ts";
import { parseWatchlist } from "./watchlist.ts";
import { createTrpcHandler } from "./trpc-handler.ts";
import type { AppRouter } from "./trpc.ts";

async function testDatabase(t: TestContext) {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || !new URL(value).pathname.endsWith("_test")) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL control database ending in _test.");
  const control = createDatabase(value);
  const name = `spooktober_test_${randomUUID().replaceAll("-", "")}`;
  await control.query(`CREATE DATABASE "${name}"`);
  const url = new URL(value); url.pathname = `/${name}`;
  const pool = createDatabase(url.href);
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await pool.end(); await control.query(`DROP DATABASE "${name}" WITH (FORCE)`); await control.end(); });
  return { pool, url, control, cleanup };
}

const seed = async () => parseWatchlist(await readFile("src/seed.json"));

test("migrations are explicit, repeatable and reject incompatible history", async (t) => {
  const { pool } = await testDatabase(t);
  await assert.rejects(readyDatabase(pool));
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  await readyDatabase(pool);
  assert.deepEqual(await listFilms(pool), []);
  await pool.query("INSERT INTO schema_migrations (version) VALUES (2)");
  await assert.rejects(readyDatabase(pool));
  await assert.rejects(migrateDatabase(pool));
});

test("watched dates, idempotent adds and stale reorders preserve the list", async (t) => {
  const { pool } = await testDatabase(t);
  await migrateDatabase(pool); await importFilms(pool, await seed());
  let films = await markWatched(pool, "film-06", true);
  assert.equal(films[5].watchedAt, null);
  films = await markWatched(pool, "film-01", true);
  const date = films[0].watchedAt;
  assert.ok(date);
  assert.equal((await markWatched(pool, "film-01", true))[0].watchedAt, date);
  const id = randomUUID();
  await addFilm(pool, id, "The Thing"); await addFilm(pool, id, "The Thing");
  await assert.rejects(addFilm(pool, id, "Another film"), { status: 409 });
  films = await reorderFilms(pool, ["film-02", "film-01"]);
  assert.equal(films.length, 21);
  assert.deepEqual(films.slice(0, 2).map((film) => film.id), ["film-02", "film-01"]);
  assert.equal(films.at(-1)?.id, id);
  assert.equal((await markWatched(pool, "film-01", false)).find((film) => film.id === "film-01")?.watchedAt, null);
  await assert.rejects(markWatched(pool, "missing", true), { status: 404 });
});

test("independent connection pools retain all simultaneous adds, ticks and reorders", async (t) => {
  const { pool, url, cleanup } = await testDatabase(t);
  await migrateDatabase(pool); await importFilms(pool, await seed());
  const other = createDatabase(url.href); cleanup.push(() => other.end());
  const pools = [pool, other];
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    await Promise.all([
      addFilm(pools[i % 2], randomUUID(), `Concurrent film ${i}`),
      reorderFilms(pools[(i + 1) % 2], ["film-02", "film-01"]),
      markWatched(pools[i % 2], "film-01", true),
    ]);
  }));
  const films = await listFilms(other);
  assert.equal(films.length, 32);
  assert.equal(new Set(films.map((film) => film.id)).size, 32);
  assert.deepEqual(films.map((film) => film.position), Array.from({ length: 32 }, (_, i) => i));
  assert.equal(films.find((film) => film.id === "film-01")?.watched, true);
});

test("JSON restore preserves nanoseconds, refuses overwrite and rolls back partial inserts", async (t) => {
  const { pool } = await testDatabase(t);
  await migrateDatabase(pool);
  const films = parseWatchlist(JSON.stringify({ films: [{ id: "from-old-release", title: "The Thing", watched: true, watchedAt: null, updatedAt: "2026-10-05T10:30:00.123456789Z" }] }));
  await importFilms(pool, films);
  assert.deepEqual(await listFilms(pool), films);
  await assert.rejects(importFilms(pool, films));
  const { pool: copy } = await testDatabase(t); await migrateDatabase(copy);
  await importFilms(copy, parseWatchlist(JSON.stringify({ films: await listFilms(pool) })));
  assert.deepEqual(await listFilms(copy), films);
  const { pool: clean } = await testDatabase(t); await migrateDatabase(clean);
  await assert.rejects(importFilms(clean, [films[0], { ...films[0], id: "second", title: " " }]));
  assert.deepEqual(await listFilms(clean), []);
});

test("tRPC transport validates inputs, requires auth and rejects unsafe requests", async (t) => {
  const { pool, url, cleanup } = await testDatabase(t); await migrateDatabase(pool); await importFilms(pool, await seed());
  const globals = globalThis as typeof globalThis & { spooktoberDatabase?: Pool };
  const previous = { ...process.env };
  process.env.DATABASE_URL = url.href; process.env.CLERK_ALLOWED_USER_IDS = "user_Kyle,user_Rhiann"; process.env.PUBLIC_URL = "https://films.example.com";
  globals.spooktoberDatabase = pool;
  cleanup.push(async () => { delete globals.spooktoberDatabase; process.env = previous; });
  let userId: string | null = "user_Kyle";
  const trpcHandler = createTrpcHandler(async () => userId);
  const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://localhost/api/trpc", headers: { origin: "https://films.example.com", "x-spooktober-request": "1" }, fetch: (url, options) => trpcHandler(new Request(url, options as RequestInit)) })] });
  assert.equal((await client.films.list.query()).length, 20);
  const id = randomUUID();
  assert.equal((await client.films.add.mutate({ id, title: " The Thing " })).at(-1)?.title, "The Thing");
  assert.equal((await client.films.setWatched.mutate({ id, watched: true })).at(-1)?.watched, true);
  assert.equal((await client.films.reorder.mutate({ ids: [id] }))[0].id, id);
  await assert.rejects(client.films.add.mutate({ id: randomUUID(), title: " " }), /Enter a film title/);
  await assert.rejects(client.films.reorder.mutate({ ids: [id, id] }), /Each film must appear once/);
  const beforeDenied = await listFilms(pool);
  userId = null;
  const denied = await trpcHandler(new Request("http://localhost/api/trpc/films.list", { headers: { "x-user-id": "user_Kyle", "x-clerk-auth-status": "signed-in", "x-clerk-auth-user-id": "user_Kyle" } }));
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("cache-control")!, /no-store/);
  assert.equal(denied.headers.get("www-authenticate"), null);
  const post = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/trpc/films.add", { method: "POST", headers: { origin: "https://films.example.com", "x-spooktober-request": "1", "content-type": "application/json", ...headers }, body });
  assert.equal((await trpcHandler(post("{}"))).status, 401);
  userId = "user_SomeoneElse";
  assert.equal((await trpcHandler(new Request("http://localhost/api/trpc/films.list"))).status, 403);
  assert.equal((await trpcHandler(post("{}"))).status, 403);
  assert.deepEqual(await listFilms(pool), beforeDenied);
  userId = "user_Rhiann";
  assert.equal((await client.films.list.query()).length, 21);
  assert.equal((await trpcHandler(post("{}", { origin: "https://elsewhere.example" }))).status, 403);
  assert.equal((await trpcHandler(post("{}", { "content-type": "text/plain" }))).status, 415);
  assert.equal((await trpcHandler(post("{"))).status, 400);
  assert.equal((await trpcHandler(post("x".repeat(17000)))).status, 413);
});

test("a restricted runtime role can save films but cannot create schema or alter migration history", async (t) => {
  const { pool, url, control, cleanup } = await testDatabase(t); await migrateDatabase(pool); await importFilms(pool, await seed());
  const role = `spooktober_role_${randomUUID().replaceAll("-", "")}`;
  await control.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local-runtime-only'`);
  await pool.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await grantRuntimeAccess(pool, role); await grantRuntimeAccess(pool, role);
  url.username = role; url.password = "local-runtime-only";
  const runtime = createDatabase(url.href);
  cleanup.push(async () => { await runtime.end(); await pool.query(`DROP OWNED BY "${role}"`); await control.query(`DROP ROLE "${role}"`); });
  await readyDatabase(runtime);
  const id = randomUUID(); await addFilm(runtime, id, "Runtime film"); await markWatched(runtime, id, true); await reorderFilms(runtime, [id]);
  await assert.rejects(runtime.query("CREATE TABLE forbidden (id integer)"));
  await assert.rejects(runtime.query("DELETE FROM films"));
  await assert.rejects(runtime.query("INSERT INTO schema_migrations (version) VALUES (2)"));
  await assert.rejects(migrateDatabase(runtime));
});

test("runtime grants reject unsafe role names and unmigrated databases", async (t) => {
  const { pool } = await testDatabase(t);
  await assert.rejects(grantRuntimeAccess(pool, "spooktober_runtime"));
  await migrateDatabase(pool);
  for (const role of ['x"; DROP TABLE films; --', "Mixed", "", "a".repeat(64)]) await assert.rejects(grantRuntimeAccess(pool, role), /role name/);
  await assert.rejects(grantRuntimeAccess(pool, "spooktober_missing_role"));
  await readyDatabase(pool);
});
