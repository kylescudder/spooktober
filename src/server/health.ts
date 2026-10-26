import '@tanstack/react-start/server-only'
import postgres from 'postgres'
import { databaseConfig } from './database'
import { privateHeaders } from './auth'
import { readAuthEnv } from './env'

let healthProbe: Promise<void> | undefined

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

async function probeDatabase() {
  // Own this connection so a deadline can retire it without touching the app pool.
  const { url, ...options } = databaseConfig(process.env.DATABASE_URL, 1)
  const client = postgres(url, {
    ...options,
    connect_timeout: 3,
    connection: { ...options.connection, statement_timeout: 3000 }
  })
  const query = client`SELECT id FROM films LIMIT 0`
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 3000)
        timer.unref()
      })
    ])
  } catch (error) {
    // Closing the socket doesn't stop a backend waiting on a lock, so cancel it.
    // The cancel request uses its own connection, so bound it too.
    await Promise.race([query.cancel(), sleep(500)]).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    // A SQL statement timeout cannot stop a socket that never reaches Postgres.
    await client.end({ timeout: 0 })
  }
}

export async function healthResponse() {
  const revision = readAuthEnv().SPOOKTOBER_REVISION
  const headers = { ...privateHeaders, 'X-Spooktober-Revision': revision }
  healthProbe ??= probeDatabase().finally(() => {
    healthProbe = undefined
  })
  try {
    await healthProbe
    return Response.json({ ok: true, revision }, { headers })
  } catch {
    return Response.json({ ok: false }, { status: 503, headers })
  }
}
