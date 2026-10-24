import { z } from "zod";

export const currentYear = () => new Date().getFullYear();
export const yearSchema = z.number().int().min(1900).max(9999);
export const seasonSchema = z.object({ year: yearSchema });

// Bad or missing URL values fall back to this year's watchlist.
export function watchlistSearch(search: Record<string, unknown>): { year?: number } {
  const parsed = yearSchema.safeParse(
    typeof search.year === "string" && /^\d{4}$/.test(search.year) ? Number(search.year) : search.year,
  );
  // Router merges validated search with the raw URL. Explicitly overwrite a
  // rejected value so it cannot leak through to loader dependencies.
  return { year: parsed.success ? parsed.data : undefined };
}

export function pickerYears(year: number) {
  const latest = Math.max(currentYear() + 1, year);
  const earliest = Math.min(2020, year);
  return Array.from({ length: latest - earliest + 1 }, (_, index) => latest - index);
}
