import { z } from 'zod'
import { yearSchema } from './years.ts'

export class FilmError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}

const titleMessage = 'Enter a film title between 1 and 200 characters.'
export const titleSchema = z
  .string({ error: titleMessage })
  .trim()
  .min(1, titleMessage)
  .max(200, titleMessage)
  .refine((title) => !title.includes('\0'), titleMessage)
export const filmIdSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (id) => !id.includes('\0') && !id.includes('/'),
    'Please send a valid film identifier.'
  )
export const newIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'Please send a valid new film identifier.'
  )
export const addFilmSchema = z.object({ id: newIdSchema, title: titleSchema })
export const editFilmSchema = z.object({ id: filmIdSchema, title: titleSchema })
export const removeFilmSchema = z.object({ id: filmIdSchema })
export const watchedSchema = z.object({
  watched: z.boolean({ error: 'Watched must be true or false.' })
})
export const setWatchedSchema = watchedSchema.extend({ id: filmIdSchema })
export const orderSchema = z.object({
  ids: z
    .array(filmIdSchema)
    .min(1, 'Please send a valid film order.')
    .max(1000, 'Please send a valid film order.')
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Each film must appear once in the order.'
    )
})
export const filmSchema = z.object({
  id: filmIdSchema,
  title: titleSchema,
  position: z.number().int().nonnegative(),
  watched: z.boolean(),
  watchedAt: z.string().nullable(),
  updatedAt: z.string(),
  createdAt: z.string().optional()
})
export const watchlistImportSchema = z.object({
  films: z
    .array(
      z.object({
        id: filmIdSchema,
        title: titleSchema,
        watched: z.boolean(),
        watchedAt: z.string().nullish(),
        updatedAt: z.string().optional(),
        createdAt: z.string().optional(),
        year: yearSchema.optional()
      })
    )
    .max(100000)
})

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new FilmError(
      result.error.issues[0]?.message ?? 'Please send a valid film change.'
    )
  return result.data
}

export const parseTitle = (input: unknown) =>
  parse(z.object({ title: titleSchema }), input).title
export const parseNewId = (input: unknown) =>
  parse(z.object({ id: newIdSchema }), input).id
export const parseWatched = (input: unknown) =>
  parse(watchedSchema, input).watched
export const parseOrder = (input: unknown) => parse(orderSchema, input).ids

export function completeOrder(
  requested: string[],
  existing: string[]
): string[] {
  const known = new Set(existing)
  if (requested.some((id) => !known.has(id)))
    throw new FilmError(
      'The film list has changed. Refresh it and try again.',
      409
    )
  const requestedIds = new Set(requested)
  return [...requested, ...existing.filter((id) => !requestedIds.has(id))]
}
