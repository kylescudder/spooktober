import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import type { Database } from './database.ts'
import { authUser } from './auth-schema.ts'
import { userProfile } from './profile-schema.ts'
import { avatarPath, avatarURL } from './profile-avatar.ts'
import { isVerifiedAllowedUser } from './auth-policy.ts'
import type { AuthUser } from './auth-factory.ts'

export type ProfileSettings = {
  origin: string
  // Read on every request, so removing an address revokes access at once.
  allowedEmails: () => readonly string[]
  getSession: (headers: Headers) => Promise<{ user: AuthUser } | null>
}

export const maxAvatarBytes = 2 * 1024 * 1024

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

class ProfileError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

// Stream the body with a hard limit, whatever Content-Length claims.
async function readBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit)
    throw new ProfileError(413, 'This photo is too large.')
  const reader = request.body?.getReader()
  if (!reader) throw new ProfileError(400, 'Choose a photo to upload.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new ProfileError(413, 'This photo is too large.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

// Only these signatures reach the image decoder.
function detectFormat(body: Buffer) {
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg'
  if (body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'png'
  if (
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'webp'
  return null
}

// Validate, square-crop to 256px and re-encode as JPEG. Re-encoding drops EXIF
// (including location) and never serves the uploaded bytes back.
export async function processAvatar(body: Buffer) {
  const format = detectFormat(body)
  if (!format)
    throw new ProfileError(400, 'Choose a valid JPEG, PNG or WebP photo.')
  try {
    const image = sharp(body, {
      failOn: 'error',
      limitInputPixels: 4_000_000,
      animated: false
    })
    const metadata = await image.metadata()
    if (metadata.format !== format || (metadata.pages ?? 1) > 1)
      throw new Error('Unsupported image')
    return await image
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer()
  } catch {
    throw new ProfileError(
      400,
      'This photo could not be read. Choose a different JPEG, PNG or WebP image.'
    )
  }
}

// GET, PUT and DELETE on /api/profile/avatar for the signed-in user's own
// photo only. The user comes from the session, never from request input.
export function createProfileHandler(
  database: Database,
  settings: ProfileSettings
) {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: privateHeaders })
  return async function profileHandler(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== avatarPath)
        return json({ error: 'Not found' }, 404)
      if (!['GET', 'PUT', 'DELETE'].includes(request.method))
        return json({ error: 'Method not allowed' }, 405)
      if (
        request.method !== 'GET' &&
        (request.headers.get('origin') !== settings.origin ||
          request.headers.get('sec-fetch-site') === 'cross-site')
      )
        return json({ error: 'Cross-site request refused' }, 403)
      const session = await settings.getSession(request.headers)
      if (!session)
        return json({ error: 'Please sign in to manage your profile.' }, 401)
      if (!isVerifiedAllowedUser(session.user, settings.allowedEmails()))
        return json(
          { error: 'This watchlist is private to Kyle and Rhiann.' },
          403
        )
      const userId = session.user.id

      if (request.method === 'GET') {
        const [row] = await database
          .select({ avatar: userProfile.avatar })
          .from(userProfile)
          .where(eq(userProfile.userId, userId))
        if (!row?.avatar) return json({ error: 'No profile photo' }, 404)
        return new Response(new Uint8Array(row.avatar), {
          headers: {
            ...privateHeaders,
            'Content-Type': 'image/jpeg',
            'Content-Security-Policy': "default-src 'none'; sandbox"
          }
        })
      }

      if (request.method === 'PUT') {
        const type = request.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase()
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type ?? ''))
          throw new ProfileError(415, 'Choose a JPEG, PNG or WebP photo.')
        const avatar = await processAvatar(
          await readBody(request, maxAvatarBytes)
        )
        // A new version on every upload, so the UI never shows a stale photo.
        const avatarVersion = randomUUID()
        const image = avatarURL(avatarVersion)
        await database.transaction(async (tx) => {
          await tx
            .insert(userProfile)
            .values({ userId, avatar, avatarVersion })
            .onConflictDoUpdate({
              target: userProfile.userId,
              set: { avatar, avatarVersion, updatedAt: new Date() }
            })
          await tx
            .update(authUser)
            .set({ image, updatedAt: new Date() })
            .where(eq(authUser.id, userId))
        })
        return json({ image })
      }

      await database.transaction(async (tx) => {
        await tx
          .update(userProfile)
          .set({ avatar: null, avatarVersion: null, updatedAt: new Date() })
          .where(eq(userProfile.userId, userId))
        await tx
          .update(authUser)
          .set({ image: null, updatedAt: new Date() })
          .where(eq(authUser.id, userId))
      })
      return json({ image: null })
    } catch (error) {
      if (error instanceof ProfileError)
        return json({ error: error.message }, error.status)
      // Never expose database or authentication details.
      return json(
        { error: 'Unable to update your profile photo. Please try again.' },
        500
      )
    }
  }
}
