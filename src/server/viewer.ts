import '@tanstack/react-start/server-only'
import type { Viewer } from './auth.ts'
import { getBetterAuth } from './better-auth.ts'

// Resolve the signed-in viewer from the verified Better Auth session only.
export async function resolveViewer(headers: Headers): Promise<Viewer> {
  const session = await getBetterAuth().api.getSession({ headers })
  if (!session) return null
  const { id, email, emailVerified } = session.user
  return { id, email, emailVerified }
}
