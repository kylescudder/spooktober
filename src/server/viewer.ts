import '@tanstack/react-start/server-only'
import { auth } from '@clerk/tanstack-react-start/server'
import { authConfiguration, type Viewer } from './auth.ts'
import { getBetterAuth } from './better-auth.ts'

// Resolve the signed-in viewer through the selected provider only.
export async function resolveViewer(headers: Headers): Promise<Viewer> {
  if (authConfiguration().provider === 'better-auth') {
    const session = await getBetterAuth().api.getSession({ headers })
    if (!session) return null
    const { id, email, emailVerified } = session.user
    return { id, email, emailVerified }
  }
  return (await auth({ acceptsToken: 'session_token' })).userId
}
