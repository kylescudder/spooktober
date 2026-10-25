import '@tanstack/react-start/server-only'
import { database, readyDatabase } from './database'
import { privateHeaders } from './auth'

let healthProbe: Promise<void> | undefined

async function probeDatabase() {
  const client = await database().connect()
  let discard = false
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await readyDatabase(client)
    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discard = true
    }
    throw error
  } finally {
    client.release(discard)
  }
}

export async function healthResponse() {
  const revision = process.env.SPOOKTOBER_REVISION || 'unknown'
  const headers = { ...privateHeaders, 'X-Spooktober-Revision': revision }
  healthProbe ??= probeDatabase().finally(() => {
    healthProbe = undefined
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Fail before the server's idle timeout drops the request.
    await Promise.race([
      healthProbe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 3000)
        timer.unref()
      })
    ])
    return Response.json({ ok: true, revision }, { headers })
  } catch {
    return Response.json({ ok: false }, { status: 503, headers })
  } finally {
    clearTimeout(timer)
  }
}
