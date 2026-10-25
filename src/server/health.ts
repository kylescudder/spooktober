import '@tanstack/react-start/server-only'
import pg from 'pg'
import { databaseConfig, readyDatabase } from './database'
import { privateHeaders } from './auth'

let healthProbe: Promise<void> | undefined

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

async function probeDatabase() {
  // Own this connection so a deadline can retire it without touching the app pool.
  const client = new pg.Client({
    ...databaseConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
    query_timeout: 3000
  })
  client.on('error', () => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect().then(() => readyDatabase(client)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 3000)
        timer.unref()
      })
    ])
  } finally {
    clearTimeout(timer)
    // A statement timeout cannot stop a socket that never reaches Postgres, and
    // end() waits for the server, so destroy the socket if it doesn't answer.
    await Promise.race([client.end().catch(() => {}), sleep(1000)])
    ;(
      client as unknown as { connection: { stream: { destroy(): void } } }
    ).connection.stream.destroy()
  }
}

export async function healthResponse() {
  const revision = process.env.SPOOKTOBER_REVISION || 'unknown'
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
