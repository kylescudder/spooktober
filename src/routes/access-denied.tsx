import { SignOutButton } from '@clerk/tanstack-react-start'
import { createFileRoute } from '@tanstack/react-router'
import { AuthMessage, AuthSetupMessage } from '../components/auth-message'
import { loadPage } from '../lib/page-data'

export const Route = createFileRoute('/access-denied')({
  loader: () => loadPage({ data: 'access-denied' }),
  component: AccessDeniedPage
})

function AccessDeniedPage() {
  if (!Route.useLoaderData().configured) return <AuthSetupMessage />
  return (
    <AuthMessage title='This is our little film club.'>
      <p>
        This watchlist is private to Kyle and Rhiann. Try signing in with your
        invited account.
      </p>
      <SignOutButton redirectUrl='/sign-in'>
        <button className='auth-button'>Use another account</button>
      </SignOutButton>
    </AuthMessage>
  )
}
