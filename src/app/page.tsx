import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { FilmList } from "../film-list";
import { AuthSetupMessage } from "../components/auth-message";
import { accessFailure, clerkConfiguration } from "../server/auth";
import { database, listFilms, readyDatabase } from "../server/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function WatchlistPage() {
  if (!clerkConfiguration().configured) return <AuthSetupMessage />;
  const { userId } = await auth({ acceptsToken: "session_token" });
  const failure = accessFailure(userId);
  if (failure?.status === 401) redirect("/sign-in");
  if (failure?.status === 403) redirect("/access-denied");
  if (failure) return <AuthSetupMessage />;
  let films = null;
  try {
    const pool = database();
    await readyDatabase(pool);
    films = await listFilms(pool);
  } catch {
    // The client keeps a visible retry path when PostgreSQL is temporarily down.
    console.error("Spooktober could not load the initial watchlist from PostgreSQL.");
  }
  return <FilmList initialFilms={films} />;
}
