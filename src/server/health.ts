import '@tanstack/react-start/server-only'
import { database, readyDatabase } from './database'
import { privateHeaders } from './auth'

export async function healthResponse() {
  try {
    await readyDatabase(database())
    const revision = process.env.SPOOKTOBER_REVISION || 'unknown'
    return new Response(`ok\nrevision ${revision}\n`, {
      headers: {
        ...privateHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Spooktober-Revision': revision
      }
    })
  } catch {
    return new Response('unavailable\n', {
      status: 503,
      headers: privateHeaders
    })
  }
}
