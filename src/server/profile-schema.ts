import { customType, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { authUser } from './auth-schema.ts'

const binary = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

// One small, re-encoded profile photo per Better Auth user. It lives in the
// app's own PostgreSQL, so the existing encrypted backups already cover it.
export const userProfile = pgTable('user_profile', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  avatar: binary('avatar'),
  avatarVersion: text('avatar_version'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
})
