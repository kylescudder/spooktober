import { createFileRoute } from "@tanstack/react-router";
import { UserButton } from "@clerk/tanstack-react-start";
import { FilmList } from "../film-list";
import { AuthSetupMessage } from "../components/auth-message";
import { loadWatchlistPage } from "../lib/page-data";
import { watchlistSearch } from "../lib/years";

export const Route = createFileRoute("/")({
  validateSearch: watchlistSearch,
  loaderDeps: ({ search }) => ({ year: search.year }),
  loader: ({ deps }) => loadWatchlistPage({ data: deps }),
  component: WatchlistPage,
});

function WatchlistPage() {
  const { configured, films, year } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  return configured ? <FilmList key={year} year={year} initialFilms={films} account={<UserButton />}
    onYearChange={(year) => { void navigate({ search: { year } }); }} /> : <AuthSetupMessage />;
}
