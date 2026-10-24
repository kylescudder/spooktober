import { auth } from '@clerk/tanstack-react-start/server'
import { createFileRoute } from '@tanstack/react-router'
import { createTrpcHandler } from '../server/trpc-handler'

const handler = createTrpcHandler(
  async () => (await auth({ acceptsToken: 'session_token' })).userId
)

export const Route = createFileRoute('/api/trpc/$')({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request)
    }
  }
})
