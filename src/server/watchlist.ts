import "@tanstack/react-start/server-only";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Film, ImportedFilm } from "../lib/films.ts";
import { watchlistImportSchema } from "../lib/validation.ts";

// Date only has millisecond precision; retain the original fractional seconds.
export function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("Import contains an invalid film timestamp.");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("Import contains an invalid film timestamp.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error("Import contains an invalid film timestamp.");
  }
  const date = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`);
  if (!Number.isFinite(date.getTime())) throw new Error("Import contains an invalid film timestamp.");
  const precision = fraction.replace(/0+$/, "");
  return `${date.toISOString().split(".")[0]}${precision ? `.${precision}` : ""}Z`;
}

const importLimit = 16 * 1024 * 1024;

export function parseWatchlist(data: Uint8Array | string): ImportedFilm[] {
  if (Buffer.byteLength(data) > importLimit) throw new Error("Watchlist import exceeds 16 MiB.");
  let input: unknown;
  try { input = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")); }
  catch { throw new Error("Import must contain valid watchlist JSON."); }
  const parsed = watchlistImportSchema.safeParse(input);
  if (!parsed.success) throw new Error("Import must contain valid films with IDs, titles, watched flags, years and timestamps (at most 100000 films total).");
  const films = parsed.data.films;
  const seen = new Set<string>();
  const positions = new Map<number | undefined, number>();
  if (films.some((film) => film.year !== undefined) && films.some((film) => film.year === undefined)) {
    throw new Error("Import must either specify a year for every film or omit all years for a single season.");
  }
  return films.map((film): ImportedFilm => {
    const position = positions.get(film.year) ?? 0;
    if (position >= 1000) throw new Error("Import exceeds 1000 films in one year.");
    positions.set(film.year, position + 1);
    if (seen.has(film.id)) throw new Error("Import contains a repeated film.");
    seen.add(film.id);
    const watchedAt = film.watchedAt == null ? null : normalizeTimestamp(film.watchedAt);
    if (!film.watched && watchedAt !== null) throw new Error("An unwatched film cannot have a watched date.");
    const updatedAt = film.updatedAt === undefined || film.updatedAt === "" ? new Date().toISOString() : normalizeTimestamp(film.updatedAt);
    const createdAt = film.createdAt === undefined || film.createdAt === "" ? updatedAt : normalizeTimestamp(film.createdAt);
    return { id: film.id, title: film.title, position, watched: film.watched, watchedAt, updatedAt, createdAt,
      ...(film.year === undefined ? {} : { year: film.year }) };
  });
}

export async function readWatchlist(source: string): Promise<ImportedFilm[]> {
  const stream = source === "-" ? process.stdin : createReadStream(source);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > importLimit) throw new Error("Watchlist import exceeds 16 MiB.");
    chunks.push(bytes);
  }
  return parseWatchlist(Buffer.concat(chunks));
}

export async function exportWatchlist(films: Film[], destination: string) {
  const data = `${JSON.stringify({ films }, null, 2)}\n`;
  if (destination === "-") {
    await new Promise<void>((resolve, reject) => process.stdout.write(data, (error) => error ? reject(error) : resolve()));
    return;
  }
  const temporary = join(dirname(destination), `.spooktober-export-${randomUUID()}`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
