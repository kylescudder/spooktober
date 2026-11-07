import '@tanstack/react-start/server-only'
import { clerkMiddleware } from '@clerk/tanstack-react-start/server'
import { createCsrfMiddleware, createMiddleware } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { authConfiguration, configuration, privateHeaders } from './auth'
import { healthResponse } from './health'

const privateRequests = createMiddleware().server(async ({ request, next }) => {
  // Set these before Clerk so its handshake redirects also remain private.
  for (const [name, value] of Object.entries(privateHeaders))
    setResponseHeader(name, value)
  const path = new URL(request.url).pathname
  // Readiness must stay independent of sign-in and contain no watchlist data.
  if (path === '/healthz' && ['GET', 'HEAD'].includes(request.method))
    return healthResponse()
  const auth = authConfiguration()
  // Better Auth endpoints do not exist while Clerk is selected.
  if (path.startsWith('/api/auth/') && auth.provider !== 'better-auth')
    return new Response('Not found', { status: 404, headers: privateHeaders })
  if (path.startsWith('/api/') && !auth.configured) {
    return Response.json(
      { error: 'Sign-in is still being set up. Please try again later.' },
      { status: 503, headers: privateHeaders }
    )
  }
  return next()
})

const csrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn'
})

export function requestOptions() {
  const auth = authConfiguration()
  const { publicURL } = configuration()
  return {
    requestMiddleware: [
      privateRequests,
      csrf,
      // Better Auth needs no middleware: routes and tRPC read its session.
      ...(auth.provider === 'clerk' && auth.configured
        ? [
            clerkMiddleware({
              publishableKey: auth.publishableKey,
              signInUrl: '/sign-in',
              signUpUrl: '/sign-in',
              authorizedParties: publicURL
                ? [publicURL]
                : ['http://localhost:8080', 'http://127.0.0.1:8080']
            })
          ]
        : [])
    ]
  }
}
