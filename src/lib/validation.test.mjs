import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTitle, parseWatched, parseOrder, completeOrder, parseNewId } from "./validation.ts";

test("film changes reject invalid titles, coerced watched flags and duplicate order entries", () => {
  assert.equal(parseTitle({ title: "  The Thing  " }), "The Thing");
  for (const input of [null, [], { title: " " }, { title: "x".repeat(201) }]) assert.throws(() => parseTitle(input));
  assert.equal(parseWatched({ watched: false }), false);
  for (const value of [1, "true", null]) assert.throws(() => parseWatched({ watched: value }));
  assert.throws(() => parseOrder({ ids: ["film-01", "film-01"] }));
  assert.throws(() => parseNewId({ id: "film-01" }));
  assert.equal(parseNewId({ id: "04623b3c-2f56-4e4d-83d1-a82c7f05f09c" }), "04623b3c-2f56-4e4d-83d1-a82c7f05f09c");
});

test("reordering retains films added by the other viewer and rejects unknown identifiers", () => {
  assert.deepEqual(completeOrder(["b", "a"], ["a", "b", "new"]), ["b", "a", "new"]);
  assert.throws(() => completeOrder(["unknown"], ["a", "b"]), { status: 409 });
});

test("the supplied twenty-film seed preserves order, three watched flags and unknown viewing dates", () => {
  const { films } = JSON.parse(readFileSync(new URL("../seed.json", import.meta.url), "utf8"));
  assert.equal(films.length, 20);
  assert.equal(films[0].title, "Terrifier");
  assert.equal(films[19].title, "Carrie");
  assert.deepEqual(films.filter((film) => film.watched).map((film) => film.title), ["Scream 7", "Iron Lung", "Primate"]);
  assert.ok(films.every((film, position) => film.position === position && film.watchedAt === null));
});
