import '@tanstack/react-start/server-only'
import { initTRPC, TRPCError } from '@trpc/server'
import { ZodError } from 'zod'
import {
  addFilmSchema,
  filmSchema,
  FilmError,
  orderSchema,
  setWatchedSchema
} from '../lib/validation.ts'
import { accessFailure } from './auth.ts'
import {
  addFilm,
  database,
  listFilms,
  markWatched,
  readyDatabase,
  reorderFilms
} from './database.ts'
import { currentYear, seasonSchema } from '../lib/years.ts'

// userId comes only from Clerk's verified server session, never request input.
const t = initTRPC.context<{ userId: string | null }>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message:
        error.cause instanceof ZodError
          ? (error.cause.issues[0]?.message ??
            'Please send a valid film change.')
          : shape.message
    }
  }
})

const authenticated = t.procedure.use(async ({ ctx, next }) => {
  const failure = accessFailure(ctx.userId)
  if (failure)
    throw new TRPCError({
      code:
        failure.status === 401
          ? 'UNAUTHORIZED'
          : failure.status === 403
            ? 'FORBIDDEN'
            : 'SERVICE_UNAVAILABLE',
      message: failure.error
    })
  return next()
})

async function storage<T>(work: () => Promise<T>): Promise<T> {
  try {
    await readyDatabase(database())
    return await work()
  } catch (error) {
    if (error instanceof FilmError) {
      const code =
        error.status === 404
          ? 'NOT_FOUND'
          : error.status === 409
            ? 'CONFLICT'
            : 'BAD_REQUEST'
      throw new TRPCError({ code, message: error.message })
    }
    console.error('Spooktober could not complete a PostgreSQL film request.')
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The watchlist is temporarily unavailable. Please try again.'
    })
  }
}

export const appRouter = t.router({
  films: t.router({
    list: authenticated
      .input(seasonSchema.default(() => ({ year: currentYear() })))
      .output(filmSchema.array())
      .query(({ input }) => storage(() => listFilms(database(), input.year))),
    add: authenticated
      .input(addFilmSchema.extend(seasonSchema.shape))
      .output(filmSchema.array())
      .mutation(({ input }) =>
        storage(() => addFilm(database(), input.id, input.title, input.year))
      ),
    setWatched: authenticated
      .input(setWatchedSchema.extend(seasonSchema.shape))
      .output(filmSchema.array())
      .mutation(({ input }) =>
        storage(() =>
          markWatched(database(), input.id, input.watched, input.year)
        )
      ),
    reorder: authenticated
      .input(orderSchema.extend(seasonSchema.shape))
      .output(filmSchema.array())
      .mutation(({ input }) =>
        storage(() => reorderFilms(database(), input.ids, input.year))
      )
  })
})

export type AppRouter = typeof appRouter
