import { createFileRoute } from '@tanstack/react-router'
import { UserButton } from '@clerk/tanstack-react-start'
import { lazy, Suspense, useEffect } from 'react'
import { FilmList } from '../film-list'
import { AuthSetupMessage } from '../components/auth-message'
import { loadWatchlistPage } from '../lib/page-data'
import { clearPendingSignIn } from '../lib/pending-sign-in'
import { watchlistSearch } from '../lib/years'

// Loaded only for signed-in Better Auth viewers, so Clerk deployments and
// public pages never download the Better Auth UI.
const BetterAuthUserMenu = lazy(() =>
  import('../components/better-auth-user-menu').then(
    ({ BetterAuthUserMenu }) => ({ default: BetterAuthUserMenu })
  )
)

export const Route = createFileRoute('/')({
  validateSearch: watchlistSearch,
  loaderDeps: ({ search }) => ({ year: search.year }),
  loader: ({ deps }) => loadWatchlistPage({ data: deps }),
  component: WatchlistPage
})

function WatchlistPage() {
  const { configured, films, year, provider } = Route.useLoaderData()
  const navigate = Route.useNavigate()
  const betterAuth = provider === 'better-auth'
  useEffect(() => {
    // The server only renders the list for a signed-in, invited viewer.
    if (betterAuth && configured) clearPendingSignIn()
  }, [betterAuth, configured])
  return configured ? (
    <FilmList
      key={year}
      year={year}
      initialFilms={films}
      account={
        betterAuth ? (
          <Suspense
            fallback={<span className='bg-muted block size-8 rounded-full' />}
          >
            <BetterAuthUserMenu />
          </Suspense>
        ) : (
          <UserButton />
        )
      }
      onYearChange={(year) => {
        void navigate({ search: { year } })
      }}
    />
  ) : (
    <AuthSetupMessage />
  )
}
