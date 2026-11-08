import { eq } from 'drizzle-orm'
import type { Database } from './database.ts'
import { userProfile } from './profile-schema.ts'

// Kept apart from the upload handler so sign-in code never loads sharp.
export const avatarPath = '/api/profile/avatar'
export const avatarURL = (version: string) => avatarPath + '?v=' + version

// The only photo value update-user may confirm: the user's current one.
export async function currentAvatarURL(database: Database, userId: string) {
  const [row] = await database
    .select({ version: userProfile.avatarVersion })
    .from(userProfile)
    .where(eq(userProfile.userId, userId))
  return row?.version ? avatarURL(row.version) : null
}
