import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthMessage, AuthSetupMessage } from '../components/auth-message'
import { loadPage } from '../lib/page-data'

export const Route = createFileRoute('/access-denied')({
  loader: () => loadPage({ data: 'access-denied' }),
  component: AccessDeniedPage
})

function AccessDeniedPage() {
  const { configured } = Route.useLoaderData()
  if (!configured) return <AuthSetupMessage />
  return (
    <AuthMessage title='This is our little film club.'>
      <p>
        This watchlist is private to Kyle and Rhiann. Try signing in with your
        invited account.
      </p>
      <BetterAuthSignOut />
    </AuthMessage>
  )
}

function BetterAuthSignOut() {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function signOut() {
    setPending(true)
    setError('')
    try {
      // Imported on demand: only uninvited viewers need the client.
      const { authClient } = await import('../lib/auth-client')
      const result = await authClient.signOut()
      if (result.error) throw new Error('Sign-out failed')
      await navigate({ href: '/auth/sign-in', replace: true })
    } catch {
      setError('We couldn’t sign you out. Please try again.')
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      {error && <p role='alert'>{error}</p>}
      <button
        className='auth-button'
        disabled={pending}
        onClick={() => void signOut()}
      >
        {pending ? 'Signing out…' : 'Use another account'}
      </button>
    </>
  )
}
