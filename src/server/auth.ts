import '@tanstack/react-start/server-only'
import { readAuthEnv, readBetterAuthEnv } from './env'
import { isVerifiedAllowedUser } from './auth-policy.ts'
import type { AuthUser } from './auth-factory.ts'

export const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
}

export interface Configuration {
  // Verified, still-invited emails. Null when Better Auth is unconfigured.
  allowedEmails: readonly string[] | null
  publicURL: string
}

// The Better Auth user the server resolved from the session, or nobody. Never
// taken from request input.
export type Viewer = AuthUser | null

function betterAuthEmails(env: Record<string, string | undefined>) {
  try {
    return readBetterAuthEnv(env).AUTH_ALLOWED_EMAILS
  } catch {
    // Missing or invalid settings keep the existing setup response.
    return null
  }
}

export function configuration(
  env: Record<string, string | undefined> = process.env
): Configuration {
  const validated = readAuthEnv(env)
  return {
    allowedEmails: betterAuthEmails(env),
    publicURL: validated.PUBLIC_URL ?? ''
  }
}

// Whether Better Auth has the settings it needs. Unconfigured apps show the
// setup message and refuse the film API.
export function authConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  return { configured: !!configuration(env).allowedEmails }
}

export function accessFailure(
  viewer: Viewer,
  config = configuration()
): { status: 401 | 403 | 503; error: string } | null {
  if (!viewer)
    return { status: 401, error: 'Please sign in to view the watchlist.' }
  if (!config.allowedEmails)
    return {
      status: 503,
      error: 'Sign-in is still being set up. Please try again later.'
    }
  if (!isVerifiedAllowedUser(viewer, config.allowedEmails))
    return {
      status: 403,
      error: 'This watchlist is private to Kyle and Rhiann.'
    }
  return null
}

export function guardMutationRequest(
  request: Request,
  config = configuration()
): Response | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null
  const url = new URL(request.url)
  const origin =
    config.publicURL ||
    `${url.protocol}//${request.headers.get('host') || url.host}`
  const suppliedOrigin = request.headers.get('origin')
  if (
    (suppliedOrigin !== null && suppliedOrigin !== origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    request.headers.get('x-spooktober-request') !== '1'
  ) {
    return Response.json(
      { error: 'This request is not allowed. Please use the watchlist page.' },
      { status: 403, headers: privateHeaders }
    )
  }
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  ) {
    return Response.json(
      { error: 'Please send film changes as JSON.' },
      { status: 415, headers: privateHeaders }
    )
  }
  return null
}
