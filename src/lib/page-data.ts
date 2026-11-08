import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { seasonSchema } from './years'

export const loadWatchlistPage = createServerFn({ method: 'GET' })
  .validator(seasonSchema.partial())
  .handler(async ({ data }) => {
    const { pageData } = await import('../server/pages')
    return pageData('watchlist', data.year)
  })

// The selected provider and whether it is configured. Only Clerk's public
// publishable key is returned; secrets stay inside the server function.
export const loadAuthConfiguration = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { authConfiguration } = await import('../server/auth')
    return authConfiguration()
  }
)

export const loadPage = createServerFn({ method: 'GET' })
  .validator(
    z.enum(['watchlist', 'sign-in', 'access-denied', 'auth', 'profile'])
  )
  .handler(async ({ data }) => {
    const { pageData } = await import('../server/pages')
    return pageData(data)
  })
