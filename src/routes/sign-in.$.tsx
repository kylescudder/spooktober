import { SignIn } from '@clerk/tanstack-react-start'
import { createFileRoute } from '@tanstack/react-router'
import { AuthMessage, AuthSetupMessage } from '../components/auth-message'
import { loadPage } from '../lib/page-data'

export const Route = createFileRoute('/sign-in/$')({
  loader: () => loadPage({ data: 'sign-in' }),
  component: SignInPage
})

function SignInPage() {
  if (!Route.useLoaderData().configured) return <AuthSetupMessage />
  return (
    <AuthMessage title='Come in. Get cosy.'>
      <p>Sign in for our Halloween film nights.</p>
      <SignIn
        routing='path'
        path='/sign-in'
        withSignUp={false}
        forceRedirectUrl='/'
      />
    </AuthMessage>
  )
}
