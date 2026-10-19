import { createFileRoute } from "@tanstack/react-router";
import { FilmList } from "../film-list";
import { AuthSetupMessage } from "../components/auth-message";
import { loadPage } from "../lib/page-data";

export const Route = createFileRoute("/")({
  loader: () => loadPage({ data: "watchlist" }),
  component: WatchlistPage,
});

function WatchlistPage() {
  const { configured, films } = Route.useLoaderData();
  return configured ? <FilmList initialFilms={films} /> : <AuthSetupMessage />;
}
