import '@tanstack/react-start/server-only'
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

type RuntimeEnv = Record<string, string | undefined>

const databaseSchema = {
  DATABASE_URL: z.url().refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      !!url.hostname &&
      !!url.pathname.replace(/\//g, '')
    )
  })
}

const origin = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
  })
  .transform((value) => new URL(value).origin)

const validation = {
  emptyStringAsUndefined: true,
  onValidationError(issues: readonly { path?: readonly unknown[] }[]): never {
    // Report setting names only; credentials must never appear in startup logs.
    throw new Error(
      'Invalid environment variables: ' +
        issues.map((issue) => issue.path?.join('.')).join(', ')
    )
  }
}

// Read at runtime, rather than during Vite's secret-free production build.
export function readDatabaseEnv(runtimeEnv: RuntimeEnv = process.env) {
  return createEnv({ server: databaseSchema, runtimeEnv, ...validation })
}

const authSchema = {
  PUBLIC_URL: origin.optional(),
  SPOOKTOBER_REVISION: z.string().default('unknown'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
}

// Variables outside these schemas, such as retired sign-in settings, are ignored.
export function readAuthEnv(runtimeEnv: RuntimeEnv = process.env) {
  return createEnv({ server: authSchema, runtimeEnv, ...validation })
}

const betterAuthSchema = {
  BETTER_AUTH_URL: origin.optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BREVO_API_KEY: z.string().min(1).optional(),
  AUTH_EMAIL_FROM: z.email().optional(),
  AUTH_EMAIL_DAILY_LIMIT: z.coerce.number().int().min(1).max(300).default(40),
  // Exact invited addresses, comma separated; there is no open sign-up.
  AUTH_ALLOWED_EMAILS: z
    .string()
    .default('')
    .transform((value) => [
      ...new Set(
        value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      )
    ])
    .pipe(z.array(z.email()))
}

// Missing settings keep the setup response rather than failing startup. Errors
// name settings only, never their values.
export function readBetterAuthEnv(runtimeEnv: RuntimeEnv = process.env) {
  const env = createEnv({
    server: { ...betterAuthSchema, NODE_ENV: authSchema.NODE_ENV },
    runtimeEnv,
    ...validation
  })
  const missing = Object.entries({
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BREVO_API_KEY: env.BREVO_API_KEY,
    AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM,
    AUTH_ALLOWED_EMAILS: env.AUTH_ALLOWED_EMAILS.length ? 'set' : undefined
  })
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length)
    throw new Error('Invalid environment variables: ' + missing.join(', '))
  if (
    env.NODE_ENV === 'production' &&
    !env.BETTER_AUTH_URL!.startsWith('https://')
  )
    throw new Error('Invalid environment variables: BETTER_AUTH_URL')
  return {
    ...env,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL!,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET!,
    BREVO_API_KEY: env.BREVO_API_KEY!,
    AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM!
  }
}

export function readEnv(runtimeEnv: RuntimeEnv = process.env) {
  return createEnv({
    server: { ...databaseSchema, ...authSchema },
    runtimeEnv,
    ...validation
  })
}
