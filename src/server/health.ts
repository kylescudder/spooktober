import '@tanstack/react-start/server-only'
import pg from 'pg'
import { databaseConfig, readyDatabase } from './database'
import { privateHeaders } from './auth'

let healthProbe: Promise<void> | undefined

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

// Fields pg sets from the server's handshake but doesn't type.
type ClientInternals = {
  processID: number | null
  connection: { stream: { destroy(): void } }
}

function probeClient(timeoutMillis: number) {
  const client = new pg.Client({
    ...databaseConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: timeoutMillis,
    statement_timeout: timeoutMillis,
    query_timeout: timeoutMillis
  })
  client.on('error', () => {})
  return client
}

async function retire(client: pg.Client) {
  // A statement timeout cannot stop a socket that never reaches Postgres, and
  // end() waits for the server, so destroy the socket if it doesn't answer.
  await Promise.race([client.end().catch(() => {}), sleep(1000)])
  ;(client as unknown as ClientInternals).connection.stream.destroy()
}

async function cancelBackend(pid: number) {
  // Closing the socket doesn't stop a backend waiting on a lock, so cancel it
  // from another connection, bounded in case that one stalls too.
  const canceller = probeClient(500)
  await Promise.race([
    canceller
      .connect()
      .then(() => canceller.query('SELECT pg_cancel_backend($1)', [pid])),
    sleep(500)
  ]).catch(() => {})
  void retire(canceller)
}

async function probeDatabase() {
  // Own this connection so a deadline can retire it without touching the app pool.
  const client = probeClient(3000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect().then(() => readyDatabase(client)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 3000)
        timer.unref()
      })
    ])
  } catch (error) {
    const pid = (client as unknown as ClientInternals).processID
    if (pid) await cancelBackend(pid)
    throw error
  } finally {
    clearTimeout(timer)
    await retire(client)
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
