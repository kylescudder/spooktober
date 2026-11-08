import { UserRound } from 'lucide-react'
import { UserButton } from '@/components/auth/user/user-button'
import { BetterAuthUIProvider } from '@/components/better-auth-ui-provider'

// Lazy-loaded by the signed-in watchlist, keeping the auth UI out of public pages.
export function BetterAuthUserMenu() {
  return (
    <BetterAuthUIProvider>
      <UserButton
        size='icon'
        align='end'
        hideSettings
        className='ring-primary/40 hover:ring-primary/80 ring-2'
        links={[
          {
            label: 'Profile',
            href: '/profile',
            icon: <UserRound />,
            visibility: 'authenticated'
          }
        ]}
      />
    </BetterAuthUIProvider>
  )
}
