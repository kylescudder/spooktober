export class FilmError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FilmError("Please send a valid film change.");
  return input as Record<string, unknown>;
}

export function parseTitle(input: unknown): string {
  const title = record(input).title;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200) throw new FilmError("Enter a film title between 1 and 200 characters.");
  return title.trim();
}

export function parseNewId(input: unknown): string {
  const id = record(input).id;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new FilmError("Please send a valid new film identifier.");
  return id;
}

export function parseWatched(input: unknown): boolean {
  const watched = record(input).watched;
  if (typeof watched !== "boolean") throw new FilmError("Watched must be true or false.");
  return watched;
}

export function parseOrder(input: unknown): string[] {
  const ids = record(input).ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000 || ids.some((id) => typeof id !== "string" || !id || id.length > 100)) throw new FilmError("Please send a valid film order.");
  if (new Set(ids).size !== ids.length) throw new FilmError("Each film must appear once in the order.");
  return ids;
}

export function completeOrder(requested: string[], existing: string[]): string[] {
  const known = new Set(existing);
  if (requested.some((id) => !known.has(id))) throw new FilmError("The film list has changed. Refresh it and try again.", 409);
  const requestedIds = new Set(requested);
  return [...requested, ...existing.filter((id) => !requestedIds.has(id))];
}
