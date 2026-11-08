import { createFileRoute, Link, Navigate } from '@tanstack/react-router'
import { Auth } from '@/components/auth/auth'
import { BetterAuthUIProvider } from '@/components/better-auth-ui-provider'
import { AuthMessage, AuthSetupMessage } from '../components/auth-message'
import { loadPage } from '../lib/page-data'

// Better Auth sign-in, email code, magic link, password reset and sign-out.
export const Route = createFileRoute('/auth/$path')({
  loader: () => loadPage({ data: 'auth' }),
  component: AuthPage
})

function AuthPage() {
  const { configured } = Route.useLoaderData()
  const { path } = Route.useParams()
  if (!configured) return <AuthSetupMessage />
  // Accounts are invited, never self-registered.
  if (path === 'sign-up')
    return <Navigate to='/auth/$path' params={{ path: 'sign-in' }} replace />
  return (
    <AuthMessage title='Come in. Get cosy.'>
      <BetterAuthUIProvider>
        <Auth path={path} className='mx-auto text-left' />
      </BetterAuthUIProvider>
      <p className='auth-footnote'>
        This watchlist is private to Kyle and Rhiann.{' '}
        <Link to='/'>Back to our film nights</Link>
      </p>
    </AuthMessage>
  )
}
