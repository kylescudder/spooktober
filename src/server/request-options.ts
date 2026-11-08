import '@tanstack/react-start/server-only'
import { createCsrfMiddleware, createMiddleware } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { authConfiguration, privateHeaders } from './auth'
import { healthResponse } from './health'

const privateRequests = createMiddleware().server(async ({ request, next }) => {
  // Every response, including redirects, stays private.
  for (const [name, value] of Object.entries(privateHeaders))
    setResponseHeader(name, value)
  const path = new URL(request.url).pathname
  // Readiness must stay independent of sign-in and contain no watchlist data.
  if (path === '/healthz' && ['GET', 'HEAD'].includes(request.method))
    return healthResponse()
  if (path.startsWith('/api/') && !authConfiguration().configured) {
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
  // Better Auth needs no middleware: routes and tRPC read its session.
  return { requestMiddleware: [privateRequests, csrf] }
}
