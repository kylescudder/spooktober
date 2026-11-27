import '@tanstack/react-start/server-only'
import { privateHeaders } from './auth.ts'
import type { SpooktoberAuth } from './auth-factory.ts'

// The only Better Auth endpoints the app exposes. Everything else, including
// sign-up and email-code password reset, answers 404.
export const authPaths = new Set([
  '/get-session',
  '/sign-out',
  '/update-user',
  '/email-otp/send-verification-otp',
  '/sign-in/email-otp',
  '/sign-in/email',
  '/sign-in/magic-link',
  '/magic-link/verify',
  '/request-password-reset',
  '/reset-password',
  '/change-password',
  '/list-accounts',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/passkey/list-user-passkeys',
  '/passkey/update-passkey',
  '/passkey/delete-passkey'
])

export function isAllowedAuthPath(path: string) {
  // The emailed reset link lands on /reset-password/<token> before redirecting.
  return authPaths.has(path) || /^\/reset-password\/[\w-]+$/.test(path)
}

export function createAuthRouteHandler(getAuth: () => SpooktoberAuth) {
  return async function authRouteHandler(request: Request) {
    const path = new URL(request.url).pathname.slice('/api/auth'.length)
    if (!isAllowedAuthPath(path))
      return new Response('Not found', { status: 404, headers: privateHeaders })
    return getAuth().handler(request)
  }
}
