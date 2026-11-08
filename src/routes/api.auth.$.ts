import { createFileRoute } from '@tanstack/react-router'
import { createAuthRouteHandler } from '../server/auth-route'
import { getBetterAuth } from '../server/better-auth'

const handler = createAuthRouteHandler(getBetterAuth)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request)
    }
  }
})
