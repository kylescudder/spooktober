import '@tanstack/react-start/server-only'
import { database, readyDatabase } from './database'
import { privateHeaders } from './auth'

export async function healthResponse() {
  const revision = process.env.SPOOKTOBER_REVISION || 'unknown'
  const headers = { ...privateHeaders, 'X-Spooktober-Revision': revision }
  try {
    // Fail before the server's idle timeout drops the request.
    await Promise.race([
      readyDatabase(database()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000).unref()
      )
    ])
    return Response.json({ ok: true, revision }, { headers })
  } catch {
    return Response.json({ ok: false }, { status: 503, headers })
  }
}
