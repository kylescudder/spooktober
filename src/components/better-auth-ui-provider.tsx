import type { ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { AuthProvider } from '@/components/auth/auth-provider'
import { Toaster } from '@/components/auth/ui/sonner'
import { passkeyPlugin } from '@/lib/auth/passkey-plugin'
import { emailOtpPlugin } from '@/lib/auth/email-otp-plugin'
import { magicLinkPlugin } from '@/lib/auth/magic-link-plugin'
import { authClient } from '@/lib/auth-client'
import { profileAvatar, profileFields } from '@/lib/profile-ui'
import { appHome, safeAppPath } from '@/lib/auth/safe-path'

// Mounted only on the auth, profile and signed-in watchlist pages. Every navigation stays on this site.
export function BetterAuthUIProvider({
  children,
  redirectTo = appHome
}: {
  children: ReactNode
  redirectTo?: string
}) {
  const navigate = useNavigate()
  return (
    <AuthProvider
      authClient={authClient}
      navigate={({ to, replace }) => {
        void navigate({ href: safeAppPath(to), replace })
      }}
      Link={({ href, ...props }) => <Link to={safeAppPath(href)} {...props} />}
      redirectTo={redirectTo}
      basePaths={{ auth: '/auth' }}
      emailAndPassword={{
        enabled: true,
        forgotPassword: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        rememberMe: false,
        requireEmailVerification: true
      }}
      additionalFields={profileFields}
      avatar={profileAvatar}
      localization={{ auth: { name: 'Display name' } }}
      plugins={[emailOtpPlugin(), magicLinkPlugin(), passkeyPlugin()]}
    >
      {children}
      <Toaster position='top-center' />
    </AuthProvider>
  )
}
