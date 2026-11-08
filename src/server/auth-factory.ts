import { createHmac } from 'node:crypto'
import { betterAuth } from 'better-auth'
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx
} from 'better-auth/api'
import { emailOTP, magicLink } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { passkey } from '@better-auth/passkey'
import { z } from 'zod'
import type { Database } from './database.ts'
import * as schema from './auth-schema.ts'
import { reserveEmailDelivery, type LinkEmailKind } from './auth-email.ts'
import { isAllowedEmail, isVerifiedAllowedUser } from './auth-policy.ts'
import { currentAvatarURL } from './profile-avatar.ts'

const hasUnsafeCharacters = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f || character === '\\'
  })

// Relative paths, or absolute URLs on this origin, only. Resolve against the
// origin rather than inspecting the string: URL parsing strips tabs/newlines
// and treats backslashes as slashes, so `/\t/evil.example` would escape a
// prefix check. Control characters and backslashes are refused outright.
export function isSameSiteTarget(target: unknown, origin: string) {
  if (typeof target !== 'string' || hasUnsafeCharacters(target)) return false
  if (!URL.canParse(target, origin)) return false
  const url = new URL(target, origin)
  // Also refuse paths that normalise to `//host` (e.g. `/.//evil.example/`).
  return url.origin === origin && !url.pathname.startsWith('//')
}

// Profile edits may change names, and confirm the photo the server already
// stored through /api/profile/avatar. Never email, verification or any other
// image value (no remote URLs or data URLs).
const profileUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    givenName: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .transform((value) => value ?? ''),
    familyName: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .transform((value) => value ?? ''),
    image: z.string().max(200).nullable()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0)

export type AuthSettings = {
  baseURL: string
  secret: string
  allowedEmails: readonly string[]
  dailyEmailLimit: number
}

export type AuthUser = { id: string; email: string; emailVerified: boolean }

export type SpooktoberAuth = {
  handler: (request: Request) => Promise<Response>
  api: {
    getSession: (input: {
      headers: Headers
    }) => Promise<{ user: AuthUser } | null>
  }
}

const unavailable = async () => {
  throw new APIError('SERVICE_UNAVAILABLE', {
    message: 'The sign-in email could not be sent. Please try again later.'
  })
}

export function createSpooktoberAuth(
  database: Database,
  settings: AuthSettings,
  sendOTP: (email: string, otp: string) => Promise<void>,
  sendLink: (
    email: string,
    kind: LinkEmailKind,
    url: string
  ) => Promise<void> = unavailable
): SpooktoberAuth {
  const origin = new URL(settings.baseURL).origin
  const publicPasskeyPaths = new Set([
    '/passkey/generate-authenticate-options',
    '/passkey/verify-authentication'
  ])
  const refuseCrossSite = (headers: Headers | undefined, strict = false) => {
    const requestOrigin = headers?.get('origin')
    if (
      (strict
        ? requestOrigin !== origin
        : !!requestOrigin && requestOrigin !== origin) ||
      headers?.get('sec-fetch-site') === 'cross-site'
    )
      throw new APIError('FORBIDDEN', { message: 'Cross-site request refused' })
  }
  const normalisedEmail = (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  const instance = betterAuth({
    appName: 'Spooktober',
    baseURL: origin,
    basePath: '/api/auth',
    secret: settings.secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(database, {
      provider: 'pg',
      transaction: true,
      schema: {
        user: schema.authUser,
        session: schema.authSession,
        account: schema.authAccount,
        verification: schema.authVerification,
        passkey: schema.authPasskey,
        rateLimit: schema.authRateLimit
      }
    }),
    session: {
      expiresIn: 7 * 86400,
      updateAge: 86400,
      freshAge: 3600,
      cookieCache: { enabled: false }
    },
    emailAndPassword: {
      enabled: true,
      // Accounts are created only for invited emails by email code or magic
      // link; a password is added later from Profile through the reset email.
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 1800,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        if (!isAllowedEmail(user.email, settings.allowedEmails)) return
        await sendLink(user.email, 'reset-password', url)
      }
    },
    user: {
      changeEmail: { enabled: false },
      additionalFields: {
        givenName: { type: 'string', required: false, defaultValue: '' },
        familyName: { type: 'string', required: false, defaultValue: '' }
      }
    },
    advanced: {
      cookiePrefix: 'spooktober-auth',
      useSecureCookies: origin.startsWith('https://'),
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      // The origin has no public port; only Cloudflare's tunnel reaches Caddy.
      // Cloudflare replaces this header instead of trusting a client-sent value.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] }
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 10 },
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-in/magic-link': { window: 60, max: 3 },
        '/magic-link/verify': { window: 60, max: 10 },
        '/request-password-reset': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 },
        '/change-password': { window: 60, max: 5 },
        '/passkey/*': { window: 60, max: 20 }
      }
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/update-user') {
          refuseCrossSite(ctx.headers, true)
          const session = await getSessionFromCtx(ctx)
          if (!isVerifiedAllowedUser(session?.user, settings.allowedEmails))
            throw new APIError('UNAUTHORIZED', {
              message: 'Sign in with your invited email first'
            })
          const parsed = profileUpdateSchema.safeParse(ctx.body)
          if (!parsed.success)
            throw new APIError('BAD_REQUEST', {
              message: 'Invalid profile update'
            })
          if (
            parsed.data.image !== undefined &&
            parsed.data.image !==
              (await currentAvatarURL(database, session!.user.id))
          )
            throw new APIError('BAD_REQUEST', {
              message: 'Upload or remove your profile photo first'
            })
          Object.assign(ctx.body, parsed.data)
        }
        if (ctx.path === '/email-otp/send-verification-otp') {
          refuseCrossSite(ctx.headers)
          const email = normalisedEmail(ctx.body?.email)
          if (ctx.body?.type !== 'sign-in')
            throw new APIError('BAD_REQUEST', {
              message: 'Unsupported sign-in method'
            })
          // Same answer for every address, so the form never reveals who is
          // invited. Only allowlisted emails reach the mailer.
          if (!isAllowedEmail(email, settings.allowedEmails))
            return ctx.json({ success: true })
          ctx.body.email = email
          if (
            !(await reserveEmailDelivery(
              database,
              email,
              settings.dailyEmailLimit
            ))
          )
            return ctx.json({ success: true })
        }
        if (
          ctx.path === '/sign-in/magic-link' ||
          ctx.path === '/request-password-reset'
        ) {
          refuseCrossSite(ctx.headers)
          // Emailed links may only return to this site.
          for (const key of [
            'callbackURL',
            'newUserCallbackURL',
            'errorCallbackURL',
            'redirectTo'
          ]) {
            const target: unknown = ctx.body?.[key]
            if (target !== undefined && !isSameSiteTarget(target, origin))
              throw new APIError('FORBIDDEN', { message: 'Invalid redirect' })
          }
          const email = normalisedEmail(ctx.body?.email)
          if (!isAllowedEmail(email, settings.allowedEmails))
            return ctx.json({ status: true })
          ctx.body.email = email
          if (
            !(await reserveEmailDelivery(
              database,
              email,
              settings.dailyEmailLimit
            ))
          )
            return ctx.json({ status: true })
        }
        if (
          ctx.path.startsWith('/passkey/') &&
          !publicPasskeyPaths.has(ctx.path)
        ) {
          const session = await getSessionFromCtx(ctx)
          if (!isVerifiedAllowedUser(session?.user, settings.allowedEmails))
            throw new APIError('UNAUTHORIZED', {
              message: 'Sign in with your invited email first'
            })
        }
      })
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAllowedEmail(user.email, settings.allowedEmails))
              throw new APIError('FORBIDDEN', {
                message: 'This watchlist is private to Kyle and Rhiann.'
              })
            return { data: { ...user, email: user.email.trim().toLowerCase() } }
          }
        }
      }
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: {
          hash: async (otp) =>
            createHmac('sha256', settings.secret)
              .update('spooktober-email-otp:' + otp)
              .digest('hex')
        },
        async sendVerificationOTP({ email, otp, type }) {
          if (
            type !== 'sign-in' ||
            !isAllowedEmail(email, settings.allowedEmails)
          )
            throw new APIError('FORBIDDEN', {
              message: 'Unsupported sign-in request'
            })
          await sendOTP(email, otp)
        }
      }),
      magicLink({
        expiresIn: 600,
        storeToken: 'hashed',
        async sendMagicLink({ email, url }) {
          if (!isAllowedEmail(email, settings.allowedEmails))
            throw new APIError('FORBIDDEN', {
              message: 'Unsupported sign-in request'
            })
          await sendLink(email, 'magic-link', url)
        }
      }),
      passkey({
        rpID: new URL(origin).hostname,
        rpName: 'Spooktober',
        origin,
        registration: { requireSession: true },
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        }
      })
    ]
  })
  // Keep the rest of the server dependent on the two operations it uses,
  // rather than exporting every plugin's generic endpoint types.
  return {
    handler: instance.handler,
    api: { getSession: (input) => instance.api.getSession(input) }
  }
}
