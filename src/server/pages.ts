import '@tanstack/react-start/server-only'
import { redirect } from '@tanstack/react-router'
import { getRequest } from '@tanstack/react-start/server'
import { accessFailure, authConfiguration } from './auth'
import { resolveViewer } from './viewer'
import { database, listFilms } from './database'
import type { Film } from '../lib/films'
import { currentYear } from '../lib/years'

export type Page = 'watchlist' | 'access-denied' | 'auth' | 'profile'

const signInPath = '/auth/sign-in'

export async function pageData(page: Page, year = currentYear()) {
  const { configured } = authConfiguration()
  const unconfigured = { configured: false, films: null, year }
  if (!configured) return unconfigured
  const ready = { configured: true, films: null, year }
  // Better Auth renders sign-in, reset and sign-out views client-side.
  if (page === 'auth') return ready
  const viewer = await resolveViewer(getRequest().headers)
  const failure = accessFailure(viewer)
  if (failure?.status === 401)
    throw redirect({
      href:
        page === 'profile' ? `${signInPath}?redirectTo=%2Fprofile` : signInPath
    })
  if (failure?.status === 503) return unconfigured
  if (page === 'access-denied') {
    if (!failure) throw redirect({ to: '/' })
    return ready
  }
  if (failure) throw redirect({ to: '/access-denied' })
  if (page === 'profile') return ready
  let films: Film[] | null = null
  try {
    films = await listFilms(database(), year)
  } catch {
    console.error(
      'Spooktober could not load the initial watchlist from PostgreSQL.'
    )
  }
  return { configured: true, films, year }
}
