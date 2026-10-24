import { currentYear } from "../../../src/lib/years";
import { sendRequest } from "../../../src/lib/trpc";

export async function loadWatchlistPage({ data }: { data: { year?: number } }) {
  const year = data.year ?? currentYear();
  let films = null;
  try { films = await sendRequest(year); } catch { /* The UI exposes retry. */ }
  return { configured: true, films, year };
}
