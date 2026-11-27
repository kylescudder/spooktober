import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '@better-auth-ui/react'
import { ArrowLeft, Clapperboard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { ChangePassword } from '@/components/auth/settings/security/change-password'
import { UserProfile } from '@/components/auth/settings/account/user-profile'
import { Passkeys } from '@/components/auth/passkey/passkeys'
import { Button } from '@/components/auth/ui/button'
import { BetterAuthUIProvider } from '@/components/better-auth-ui-provider'
import { AuthSetupMessage } from '../components/auth-message'
import { loadPage } from '../lib/page-data'
import { clearPendingSignIn } from '../lib/pending-sign-in'

// The server sends signed-out viewers to sign-in and uninvited ones to the
// access-denied page.
export const Route = createFileRoute('/profile')({
  loader: () => loadPage({ data: 'profile' }),
  component: ProfilePage
})

function ProfilePage() {
  const { configured } = Route.useLoaderData()
  if (!configured) return <AuthSetupMessage />
  return (
    <main className='profile-page'>
      <header className='masthead'>
        <span className='our-names'>
          <Clapperboard size={17} /> Kyle & Rhiann
        </span>
        <Link to='/' className='profile-back'>
          <ArrowLeft size={15} /> Back to our film nights
        </Link>
      </header>
      <h1>
        Your profile<span>.</span>
      </h1>
      <BetterAuthUIProvider redirectTo='/profile'>
        <BetterAuthProfile />
      </BetterAuthUIProvider>
    </main>
  )
}

function BetterAuthProfile() {
  // Better Auth UI's session query, not the client's nanostore: sign-in awaits
  // this query before navigating here, while the nanostore can still hold the
  // signed-out value from a "Sign in again" round trip and bounce to sign-in.
  const { data: session, isPending } = useSession(authClient)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  useEffect(() => {
    if (session) clearPendingSignIn()
    else if (!isPending)
      void navigate({
        href: '/auth/sign-in?redirectTo=%2Fprofile',
        replace: true
      })
  }, [isPending, navigate, session])
  if (!session)
    return (
      <p role='status' className='text-muted-foreground'>
        Checking sign-in…
      </p>
    )
  async function signOut() {
    setSigningOut(true)
    setError('')
    try {
      const result = await authClient.signOut()
      if (result.error) {
        setError('Unable to sign out. Please try again.')
        return
      }
      queryClient.clear()
      await navigate({ to: '/' })
    } catch {
      setError('Unable to sign out. Please try again.')
    } finally {
      setSigningOut(false)
    }
  }
  return (
    <div className='flex flex-col gap-8'>
      <UserProfile key={session.user.id} />
      <ChangePassword />
      <Passkeys />
      <p className='text-muted-foreground text-sm'>
        Email codes remain available if you forget your password or lose a
        passkey.
      </p>
      {error && (
        <p role='alert' className='text-destructive'>
          {error}
        </p>
      )}
      <Button
        type='button'
        variant='outline'
        size='lg'
        className='self-start'
        disabled={signingOut}
        onClick={() => void signOut()}
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  )
}
