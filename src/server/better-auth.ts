import '@tanstack/react-start/server-only'
import { database } from './database.ts'
import { readBetterAuthEnv } from './env.ts'
import { createSpooktoberAuth, type SpooktoberAuth } from './auth-factory.ts'
import { sendLinkEmail, sendLoginEmail } from './auth-email.ts'

const globals = globalThis as typeof globalThis & {
  spooktoberAuth?: SpooktoberAuth
}

// Created on first use with AUTH_PROVIDER=better-auth; Clerk deployments never
// construct it, so they need none of these settings.
export function getBetterAuth(): SpooktoberAuth {
  if (globals.spooktoberAuth) return globals.spooktoberAuth
  const env = readBetterAuthEnv()
  const origin = new URL(env.BETTER_AUTH_URL).origin
  const mail = { apiKey: env.BREVO_API_KEY, from: env.AUTH_EMAIL_FROM }
  globals.spooktoberAuth = createSpooktoberAuth(
    database(),
    {
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      allowedEmails: env.AUTH_ALLOWED_EMAILS,
      dailyEmailLimit: env.AUTH_EMAIL_DAILY_LIMIT
    },
    (email, otp) => sendLoginEmail(mail, origin, email, otp),
    (email, kind, url) => sendLinkEmail(mail, origin, email, kind, url)
  )
  return globals.spooktoberAuth
}
