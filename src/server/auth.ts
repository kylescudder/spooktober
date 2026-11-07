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

export type AuthProvider = 'clerk' | 'better-auth'

export interface Configuration {
  provider: AuthProvider
  allowedUserIDs: string[] | null
  // Better Auth only: verified, still-invited emails. Null when unconfigured.
  allowedEmails: readonly string[] | null
  publicURL: string
}

// Who the server resolved from the session: a Clerk user ID (Clerk), a Better
// Auth user (Better Auth), or nobody. Never taken from request input.
export type Viewer = string | AuthUser | null

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
  const publicURL = validated.PUBLIC_URL ?? ''
  const ids = (validated.CLERK_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
  const valid =
    ids.length >= 1 &&
    ids.length <= 2 &&
    ids.every((id) => /^user_[a-zA-Z0-9]+$/.test(id)) &&
    new Set(ids).size === ids.length
  const provider = validated.AUTH_PROVIDER
  return {
    provider,
    allowedUserIDs: valid ? ids : null,
    allowedEmails: provider === 'better-auth' ? betterAuthEmails(env) : null,
    publicURL
  }
}

// Whether the selected provider has the settings it needs. Unconfigured apps
// show the setup message and refuse the film API.
export function authConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  const { provider, allowedEmails } = configuration(env)
  if (provider === 'better-auth')
    return { provider, configured: !!allowedEmails, publishableKey: '' }
  const clerk = clerkConfiguration(env)
  return { provider, ...clerk }
}

// Read through a server-only environment object at request time. The public key
// is passed to Clerk explicitly, so a single Docker image works across instances.
export function clerkConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  const validated = readAuthEnv(env)
  const publishableKey =
    env.CLERK_PUBLISHABLE_KEY === undefined
      ? (validated.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '')
      : (validated.CLERK_PUBLISHABLE_KEY ?? '')
  const secretKey = validated.CLERK_SECRET_KEY ?? ''
  const mode = /^pk_(test|live)_[a-zA-Z0-9+/]+={0,2}$/.exec(publishableKey)?.[1]
  const configured =
    !!mode &&
    secretKey.startsWith(`sk_${mode}_`) &&
    !secretKey.includes('replace')
  return { publishableKey, configured }
}

export function accessFailure(
  viewer: Viewer,
  config = configuration()
): { status: 401 | 403 | 503; error: string } | null {
  if (!viewer)
    return { status: 401, error: 'Please sign in to view the watchlist.' }
  if (typeof viewer !== 'string') {
    // A Better Auth session never satisfies a Clerk deployment, and vice versa.
    if (config.provider !== 'better-auth' || !config.allowedEmails)
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
  const userId = viewer
  if (config.provider !== 'clerk' || !config.allowedUserIDs)
    return {
      status: 503,
      error: 'Sign-in is still being set up. Please try again later.'
    }
  if (!config.allowedUserIDs.includes(userId))
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
