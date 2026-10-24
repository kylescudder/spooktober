import '@tanstack/react-start/server-only'
import { auth } from '@clerk/tanstack-react-start/server'
import { redirect } from '@tanstack/react-router'
import { accessFailure, clerkConfiguration } from './auth'
import { database, listFilms, readyDatabase } from './database'
import type { Film } from '../lib/films'
import { currentYear } from '../lib/years'

export async function pageData(
  page: 'watchlist' | 'sign-in' | 'access-denied',
  year = currentYear()
) {
  if (!clerkConfiguration().configured)
    return { configured: false, films: null, year }
  const { userId } = await auth({ acceptsToken: 'session_token' })
  if (page === 'sign-in') {
    if (userId) throw redirect({ to: '/' })
    return { configured: true, films: null, year }
  }
  const failure = accessFailure(userId)
  if (failure?.status === 401) throw redirect({ href: '/sign-in' })
  if (failure?.status === 503) return { configured: false, films: null, year }
  if (page === 'access-denied') {
    if (!failure) throw redirect({ to: '/' })
    return { configured: true, films: null, year }
  }
  if (failure) throw redirect({ to: '/access-denied' })
  let films: Film[] | null = null
  try {
    const pool = database()
    await readyDatabase(pool)
    films = await listFilms(pool, year)
  } catch {
    console.error(
      'Spooktober could not load the initial watchlist from PostgreSQL.'
    )
  }
  return { configured: true, films, year }
}
