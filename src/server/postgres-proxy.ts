import { createServer, createConnection, type Socket } from 'node:net'

// A real PostgreSQL connection whose health-query traffic can stop responding.
// Other connections/queries continue normally, so pool starvation is observable.
export async function stallHealthQueries(
  databaseUrl: string,
  healthQuery = /^SELECT 1$/i
) {
  const target = new URL(databaseUrl)
  const sockets = new Set<Socket>()
  const stalled = new Set<Socket>()
  const held: Array<() => void> = []
  let stalling = true
  const server = createServer((client) => {
    const upstream = createConnection({
      host: target.hostname,
      port: Number(target.port || 5432)
    })
    sockets.add(client)
    sockets.add(upstream)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => {
      sockets.delete(client)
      stalled.delete(client)
      upstream.destroy()
    })
    upstream.on('close', () => {
      sockets.delete(upstream)
      client.destroy()
    })
    upstream.on('data', (data) => client.write(data))
    let buffer = Buffer.alloc(0)
    let startup = true
    let blocked = false
    const statements = new Map<string, string>()
    client.on('data', (data) => {
      buffer = Buffer.concat([
        buffer,
        typeof data === 'string' ? Buffer.from(data) : data
      ])
      if (blocked) return
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = startup
          ? buffer.readInt32BE(0)
          : buffer.readInt32BE(1) + 1
        if (buffer.length < length) return
        const packet = buffer.subarray(0, length)
        buffer = buffer.subarray(length)
        let query = ''
        if (!startup && packet[0] === 80) {
          const end = packet.indexOf(0, 5)
          const start = end + 1
          query = packet.toString('utf8', start, packet.indexOf(0, start))
          statements.set(packet.toString('utf8', 5, end), query)
        } else if (!startup && packet[0] === 66) {
          const start = packet.indexOf(0, 5) + 1
          const name = packet.toString('utf8', start, packet.indexOf(0, start))
          query = statements.get(name) || ''
        } else if (!startup && packet[0] === 81) {
          query = packet.toString('utf8', 5, packet.indexOf(0, 5))
        }
        if (startup && length === 8 && packet.readInt32BE(4) === 80877103) {
          upstream.write(packet)
          continue
        }
        startup = false
        if (stalling && healthQuery.test(query.trim())) {
          blocked = true
          stalled.add(client)
          held.push(() => {
            blocked = false
            upstream.write(Buffer.concat([packet, buffer]))
            buffer = Buffer.alloc(0)
          })
          return
        }
        upstream.write(packet)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Proxy did not bind')
  const url = new URL(databaseUrl)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  url.searchParams.set('sslmode', 'disable')
  return {
    url: url.toString(),
    get stalledConnections() {
      return stalled.size
    },
    stall() {
      stalling = true
    },
    allowNewConnections() {
      // Existing blocked sockets remain stalled; only new probes can recover.
      stalling = false
    },
    release() {
      stalling = false
      for (const release of held.splice(0)) release()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
