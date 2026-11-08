import '@tanstack/react-start/server-only'
import { authConfiguration, configuration, privateHeaders } from './auth.ts'
import { getBetterAuth } from './better-auth.ts'
import { database } from './database.ts'
import { readBetterAuthEnv } from './env.ts'
import { createProfileHandler } from './profile-handler.ts'

// Without Better Auth settings the photo endpoint does not exist.
export function handleProfileRequest(request: Request) {
  if (!authConfiguration().configured)
    return new Response('Not found', { status: 404, headers: privateHeaders })
  return createProfileHandler(database(), {
    origin: new URL(readBetterAuthEnv().BETTER_AUTH_URL).origin,
    allowedEmails: () => configuration().allowedEmails ?? [],
    getSession: (headers) => getBetterAuth().api.getSession({ headers })
  })(request)
}
