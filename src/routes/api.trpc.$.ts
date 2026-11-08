import { createFileRoute } from '@tanstack/react-router'
import { createTrpcHandler } from '../server/trpc-handler'
import { resolveViewer } from '../server/viewer'

const handler = createTrpcHandler((request) => resolveViewer(request.headers))

export const Route = createFileRoute('/api/trpc/$')({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request)
    }
  }
})
