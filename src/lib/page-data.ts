import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { seasonSchema } from './years'

export const loadWatchlistPage = createServerFn({ method: 'GET' })
  .validator(seasonSchema.partial())
  .handler(async ({ data }) => {
    const { pageData } = await import('../server/pages')
    return pageData('watchlist', data.year)
  })

export const loadPage = createServerFn({ method: 'GET' })
  .validator(z.enum(['watchlist', 'access-denied', 'auth', 'profile']))
  .handler(async ({ data }) => {
    const { pageData } = await import('../server/pages')
    return pageData(data)
  })
