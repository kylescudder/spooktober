import '@tanstack/react-start/server-only'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { accessFailure, guardMutationRequest, privateHeaders } from './auth.ts'
import { appRouter } from './trpc.ts'

// The TanStack Start route supplies Clerk's server session resolver. Tests can exercise
// transport and access policy without a live Clerk account or an auth bypass.
export function createTrpcHandler(resolveUserId: () => Promise<string | null>) {
  return async function trpcHandler(request: Request): Promise<Response> {
    const userId = await resolveUserId()
    const failure = accessFailure(userId)
    if (failure)
      return Response.json(
        { error: failure.error },
        { status: failure.status, headers: privateHeaders }
      )
    const denied = guardMutationRequest(request)
    if (denied) return denied
    // Bound the body before handing JSON parsing to tRPC, including streamed bodies.
    if (request.method === 'POST') {
      const reader = request.body?.getReader()
      if (!reader)
        return Response.json(
          { error: 'Please send a valid film change.' },
          { status: 400, headers: privateHeaders }
        )
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 16384) {
            await reader.cancel()
            return Response.json(
              { error: 'This film change is too large.' },
              { status: 413, headers: privateHeaders }
            )
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks)
      })
    }
    return fetchRequestHandler({
      endpoint: '/api/trpc',
      req: request,
      router: appRouter,
      createContext: () => ({ userId }),
      responseMeta: () => ({ headers: privateHeaders })
    })
  }
}
