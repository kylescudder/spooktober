'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Clapperboard,
  GripVertical,
  Plus,
  Check,
  Moon,
  Heart,
  LoaderCircle,
  RefreshCw,
  AlertCircle,
  ChevronDown
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { type Film } from '@/lib/films'
import {
  parseTitle,
  parseWatched,
  parseOrder,
  completeOrder
} from '@/lib/validation'

import { sendRequest, type SaveAction } from '@/lib/trpc'
import { pickerYears } from '@/lib/years'
type OptimisticChange = (films: Film[]) => Film[]
type WebTool = {
  name: string
  title: string
  description: string
  inputSchema: object
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }
  execute: (input: unknown) => unknown | Promise<unknown>
}
type ModelContext = {
  registerTool: (
    tool: WebTool,
    options: { signal: AbortSignal }
  ) => void | Promise<void>
}

function FilmRow({
  film,
  index,
  next,
  disabled,
  onWatched
}: {
  film: Film
  index: number
  next: boolean
  disabled: boolean
  onWatched: (film: Film, watched: boolean) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: film.id, disabled })
  return (
    <li
      ref={setNodeRef}
      data-film-id={film.id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 3 : undefined
      }}
      className={`film-row${film.watched ? ' is-watched' : ''}${next ? ' is-next' : ''}${isDragging ? ' is-dragging' : ''}`}
    >
      <button
        ref={setActivatorNodeRef}
        className='drag-handle'
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${film.title}`}
        disabled={disabled}
      >
        <GripVertical size={18} />
      </button>
      <span className='film-number' aria-hidden='true'>
        {String(index + 1).padStart(2, '0')}
      </span>
      <Checkbox
        id={film.id}
        className='film-checkbox'
        disabled={disabled}
        checked={film.watched}
        onCheckedChange={(checked) => onWatched(film, checked === true)}
        aria-label={`Mark ${film.title} as ${film.watched ? 'unwatched' : 'watched'}`}
      />
      <label className='film-title' htmlFor={film.id}>
        {film.title}
      </label>
      {film.watched ? (
        <span className='watched-label'>
          <Check size={13} /> Watched
        </span>
      ) : next ? (
        <span className='next-label'>Up next</span>
      ) : null}
    </li>
  )
}

export function FilmList({
  initialFilms,
  year,
  onYearChange,
  account
}: {
  initialFilms: Film[] | null
  year: number
  onYearChange: (year: number) => void
  account?: ReactNode
}) {
  const [films, setFilms] = useState<Film[]>(initialFilms ?? [])
  const [loaded, setLoaded] = useState(initialFilms !== null)
  const [saving, setSaving] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState<{
    action: SaveAction
    optimistic?: OptimisticChange
  } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [titleError, setTitleError] = useState<string | null>(null)
  const filmsRef = useRef(films)
  const busyRef = useRef(false)
  const draggingRef = useRef(false)
  const requestSerial = useRef(0)
  const retryRef = useRef(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: 'auto'
    })
  )

  const applyFilms = useCallback((next: Film[]) => {
    filmsRef.current = next
    setFilms(next)
  }, [])

  const refresh = useCallback(
    async (manual = false) => {
      if (
        busyRef.current ||
        draggingRef.current ||
        (retryRef.current && !manual)
      )
        return
      const serial = ++requestSerial.current
      try {
        const next = await sendRequest(year)
        if (
          serial !== requestSerial.current ||
          busyRef.current ||
          draggingRef.current
        )
          return
        applyFilms(next)
        setLoaded(true)
        if (!retryRef.current) setError(null)
      } catch (failure) {
        if (serial === requestSerial.current && !busyRef.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Couldn’t load the watchlist. Please try again.'
          )
      }
    },
    [applyFilms, year]
  )

  const save = useCallback(
    async (
      action: SaveAction,
      optimistic?: OptimisticChange
    ): Promise<boolean> => {
      if (busyRef.current) return false
      busyRef.current = true
      ++requestSerial.current
      const previous = filmsRef.current
      setSaving(true)
      setError(null)
      setRetry(null)
      retryRef.current = false
      if (optimistic) applyFilms(optimistic(previous))
      try {
        applyFilms(await sendRequest(year, action))
        setLoaded(true)
        return true
      } catch (failure) {
        applyFilms(previous)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Couldn’t save the watchlist. Please try again.'
        )
        setRetry({ action, optimistic })
        retryRef.current = true
        return false
      } finally {
        busyRef.current = false
        setSaving(false)
      }
    },
    [applyFilms, year]
  )

  const markWatched = useCallback(
    (film: Film, watched: boolean) =>
      save(
        { procedure: 'setWatched', input: { id: film.id, watched } },
        (current) =>
          current.map((item) =>
            item.id === film.id ? { ...item, watched } : item
          )
      ),
    [save]
  )

  useEffect(() => {
    setHydrated(true)
    void refresh()
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, 15000)
    const focus = () => {
      void refresh()
    }
    const visible = () => {
      if (!document.hidden) void refresh()
    }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visible)
    return () => {
      ++requestSerial.current
      window.clearInterval(interval)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext })
      .modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const register = (tool: WebTool) => {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal })
        ).catch(() => {})
      } catch {
        /* Unsupported registries do not affect the watchlist. */
      }
    }
    const writeAnnotations = { readOnlyHint: false, untrustedContentHint: true }
    register({
      name: 'list_films',
      title: 'List our films',
      description:
        'Read the shared film list in viewing order, including watched status.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        await refresh(true)
        return { films: filmsRef.current }
      }
    })
    register({
      name: 'set_film_watched',
      title: 'Mark a film watched',
      description:
        'Save a film’s watched or unwatched status and update the visible list.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, watched: { type: 'boolean' } },
        required: ['id', 'watched'],
        additionalProperties: false
      },
      annotations: writeAnnotations,
      execute: async (input) => {
        const watched = parseWatched(input)
        const id = (input as { id?: unknown }).id
        const film = filmsRef.current.find((item) => item.id === id)
        if (!film) throw new Error('That film is not on the watchlist.')
        if (!(await markWatched(film, watched)))
          throw new Error('The change could not be saved. Please retry.')
        return { id: film.id, watched, saved: true }
      }
    })
    register({
      name: 'reorder_films',
      title: 'Reorder our films',
      description:
        'Save the viewing order using film identifiers, retaining any newly added films.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            uniqueItems: true
          }
        },
        required: ['ids'],
        additionalProperties: false
      },
      annotations: writeAnnotations,
      execute: async (input) => {
        const ids = completeOrder(
          parseOrder(input),
          filmsRef.current.map((film) => film.id)
        )
        if (
          !(await save({ procedure: 'reorder', input: { ids } }, (current) =>
            ids.map((id, position) => ({
              ...current.find((film) => film.id === id)!,
              position
            }))
          ))
        )
          throw new Error('The order could not be saved. Please retry.')
        return { ids: filmsRef.current.map((film) => film.id), saved: true }
      }
    })
    register({
      name: 'add_film',
      title: 'Add a film',
      description:
        'Add a film to the end of the shared watchlist and update the visible list.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['title'],
        additionalProperties: false
      },
      annotations: writeAnnotations,
      execute: async (input) => {
        const name = parseTitle(input)
        const id = crypto.randomUUID()
        if (!(await save({ procedure: 'add', input: { id, title: name } })))
          throw new Error('The film could not be saved. Please retry.')
        return { id, title: name, saved: true }
      }
    })
    return () => lifecycle.abort()
  }, [refresh, save, markWatched])

  const watched = films.filter((film) => film.watched).length
  const next = films.find((film) => !film.watched)?.id
  const disabled = saving || !loaded || !hydrated

  async function finishDrag(event: DragEndEvent) {
    draggingRef.current = false
    setDragging(false)
    const { active, over } = event
    if (!over || active.id === over.id || busyRef.current) return
    const current = filmsRef.current
    const from = current.findIndex((film) => film.id === active.id)
    const to = current.findIndex((film) => film.id === over.id)
    if (from < 0 || to < 0) return
    const reordered = arrayMove(current, from, to).map((film, position) => ({
      ...film,
      position
    }))
    await save(
      {
        procedure: 'reorder',
        input: { ids: reordered.map((film) => film.id) }
      },
      () => reordered
    )
  }

  async function submitFilm(event: FormEvent) {
    event.preventDefault()
    let name: string
    try {
      name = parseTitle({ title })
    } catch (failure) {
      setTitleError((failure as Error).message)
      return
    }
    setTitleError(null)
    if (
      await save({
        procedure: 'add',
        input: { id: crypto.randomUUID(), title: name }
      })
    ) {
      setTitle('')
      setAddOpen(false)
    }
  }

  return (
    <main className='watchlist-page'>
      <header className='masthead'>
        <span className='our-names'>
          <Clapperboard size={17} /> Kyle & Rhiann
        </span>
        <div className='masthead-account'>
          <span className='season'>
            <Moon size={14} /> Halloween film nights
          </span>
          {account}
        </div>
      </header>
      <section className='intro' aria-labelledby='page-title'>
        <div className='intro-copy'>
          <div className='season-picker'>
            <label className='eyebrow' htmlFor='watchlist-year'>
              The October watchlist
            </label>
            <span className='year-select'>
              <select
                id='watchlist-year'
                aria-label='Watchlist year'
                value={year}
                disabled={!hydrated || saving || dragging}
                onChange={(event) => onYearChange(Number(event.target.value))}
              >
                {pickerYears(year).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} aria-hidden='true' />
            </span>
          </div>
          <h1 id='page-title'>
            Spooktober<span>.</span>
          </h1>
          <p className='intro-description'>
            Kyle & Rhiann’s Halloween film nights.
          </p>
        </div>
        <img
          className='header-art'
          src='/images/pumpkins-and-candles.png'
          alt=''
          width={300}
          height={200}
        />
      </section>
      <section className='progress-section' aria-label='Watching progress'>
        <div className='progress-copy'>
          <span>
            <strong>{watched}</strong> of {films.length} films watched
          </span>
          <span>{films.length - watched} to go</span>
        </div>
        <Progress
          value={films.length ? (watched / films.length) * 100 : 0}
          aria-label={`${watched} of ${films.length} films watched`}
        />
      </section>
      {error && (
        <div className='save-error' role='alert'>
          <AlertCircle size={18} />
          <span>{error}</span>
          <Button
            variant='ghost'
            disabled={saving}
            onClick={() =>
              retry
                ? void save(retry.action, retry.optimistic).then((ok) => {
                    if (ok && retry.action.procedure === 'add') {
                      setTitle('')
                      setAddOpen(false)
                    }
                  })
                : void refresh(true)
            }
          >
            <RefreshCw size={14} /> Retry
          </Button>
        </div>
      )}
      <section
        className='lineup'
        aria-labelledby='lineup-title'
        aria-busy={saving}
      >
        <div className='lineup-toolbar'>
          <div>
            <h2 id='lineup-title'>
              Our {year} line-up <span>{films.length}</span>
            </h2>
            <p>Drag to reorder. Tick when the credits roll.</p>
          </div>
          <Button
            className='add-button'
            disabled={disabled || dragging}
            onClick={() => {
              setTitleError(null)
              setAddOpen(true)
            }}
          >
            <Plus size={17} /> Add film
          </Button>
        </div>
        {!loaded ? (
          <div className='list-loading' aria-label='Loading our films'>
            <Skeleton className='h-6 w-3/4' />
            <Skeleton className='h-6 w-1/2' />
            <Skeleton className='h-6 w-2/3' />
            <p>Loading our films…</p>
          </div>
        ) : films.length === 0 ? (
          <div className='empty-list'>
            <Clapperboard size={28} />
            <p>Our first fright is waiting.</p>
            <Button onClick={() => setAddOpen(true)}>
              <Plus size={16} /> Add our first film
            </Button>
          </div>
        ) : (
          <DndContext
            id='spooktober-films'
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => {
              draggingRef.current = true
              setDragging(true)
              ++requestSerial.current
            }}
            onDragCancel={() => {
              draggingRef.current = false
              setDragging(false)
            }}
            onDragEnd={(event) => {
              void finishDrag(event)
            }}
          >
            <SortableContext
              items={films.map((film) => film.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className='film-rows'>
                {films.map((film, index) => (
                  <FilmRow
                    key={film.id}
                    film={film}
                    index={index}
                    next={film.id === next}
                    disabled={disabled}
                    onWatched={(item, value) => {
                      void markWatched(item, value)
                    }}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </section>
      <footer className='page-footer'>
        <span>
          <Heart size={13} /> Kyle & Rhiann’s watchlist
        </span>
        <span className='save-status' role='status' aria-live='polite'>
          {saving ? (
            <>
              <LoaderCircle className='spin' size={13} /> Saving…
            </>
          ) : error ? (
            'Changes not saved'
          ) : loaded ? (
            <>
              <Check size={13} /> Saved for both of us
            </>
          ) : (
            'Loading…'
          )}
        </span>
      </footer>
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!saving) setAddOpen(open)
        }}
      >
        <DialogContent className='add-dialog'>
          <DialogHeader>
            <DialogTitle>Add a film</DialogTitle>
            <DialogDescription>
              One more fright for our Halloween nights.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              void submitFilm(event)
            }}
          >
            <label htmlFor='new-film-title' className='input-label'>
              Film title
            </label>
            <Input
              id='new-film-title'
              autoFocus
              value={title}
              maxLength={200}
              placeholder='e.g. The Thing'
              aria-invalid={!!titleError}
              aria-describedby={titleError ? 'title-error' : undefined}
              onChange={(event) => {
                setTitle(event.target.value)
                setTitleError(null)
              }}
              disabled={saving}
            />
            {titleError && (
              <p id='title-error' className='field-error'>
                {titleError}
              </p>
            )}
            {error && (
              <p className='field-error' role='alert'>
                {error} Close this dialog and use Retry to try the same save
                again.
              </p>
            )}
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                disabled={saving}
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button type='submit' disabled={saving || !!retry}>
                {saving ? (
                  <LoaderCircle className='spin' size={16} />
                ) : (
                  <Plus size={16} />
                )}{' '}
                Add film
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
