// Runs in its own Bun process (see package.json) so DOM globals and auth-client
// modules do not share a module cache with the server and database tests.
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { QueryClient } from '@tanstack/react-query'

type Profile = {
  name: string
  givenName: string
  familyName: string
  email: string
  emailVerified: boolean
  image: string | null
}

const browser = new Window({ url: 'https://spooktober.auth.test' })
const originalGlobals = new Map<string, PropertyDescriptor | undefined>()
const originalFetch = globalThis.fetch
let createRoot: typeof import('react-dom/client').createRoot
let EmailOtp: typeof import('../components/auth/email-otp/email-otp').EmailOtp
let SignIn: typeof import('../components/auth/sign-in').SignIn
let authClient: typeof import('../lib/auth-client').authClient
let progress: typeof import('../lib/pending-sign-in')
let UserProfile: typeof import('../components/auth/settings/account/user-profile').UserProfile
let AuthUIProvider: typeof import('../components/auth/auth-provider').AuthProvider
let profileUI: typeof import('../lib/profile-ui')
let emailOtpUI: typeof import('../lib/auth/email-otp-plugin')
let magicLinkUI: typeof import('../lib/auth/magic-link-plugin')
let passkeyUI: typeof import('../lib/auth/passkey-plugin')
let queryTools: typeof import('@tanstack/react-query')
let profileSession = false
let profileUserId = 'first-user'
let profileClient: QueryClient | undefined
let profileState: Profile
let profileSave: unknown
let root: Root | undefined
let container: HTMLDivElement
let sends = 0
let signedIn = 0
let signInFails = false
let sendFails = false
let lastSend: unknown
let lastVerify: unknown
let sessionRequests = 0
let releaseSession: (() => void) | undefined
let delaySession = false

before(async () => {
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    Node: browser.Node,
    Element: browser.Element,
    Image: browser.Image,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLDivElement: browser.HTMLDivElement,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    sessionStorage: browser.sessionStorage,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true
  }
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        browser.location.origin
      )
      if (url.pathname === '/api/auth/update-user') {
        profileSave = JSON.parse(init?.body as string)
        profileState = { ...profileState, ...(profileSave as Partial<Profile>) }
        return Response.json({ status: true })
      }
      if (url.pathname === '/api/auth/get-session') {
        sessionRequests++
        if (delaySession)
          await new Promise<void>((resolve) => {
            releaseSession = resolve
          })
        return Response.json(
          profileSession
            ? {
                user: {
                  ...profileState,
                  id: profileUserId,
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:00Z'
                },
                session: {
                  id: 'disposable-session',
                  userId: profileUserId,
                  expiresAt: '2030-01-01T00:00:00Z',
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:00Z'
                }
              }
            : null
        )
      }
      if (url.pathname === '/api/auth/email-otp/send-verification-otp') {
        sends++
        lastSend = JSON.parse(init?.body as string)
        return sendFails
          ? Response.json(
              { code: 'SEND_FAILED', message: 'Unable to send a code' },
              { status: 500 }
            )
          : Response.json({ success: true })
      }
      if (url.pathname === '/api/auth/sign-in/email-otp') {
        lastVerify = JSON.parse(init?.body as string)
        return signInFails
          ? Response.json(
              { code: 'INVALID_OTP', message: 'Invalid code' },
              { status: 400 }
            )
          : Response.json({
              user: { emailVerified: true },
              token: 'disposable-test-token'
            })
      }
      throw new Error('Unexpected test request: ' + url.pathname)
    },
    { preconnect: originalFetch.preconnect }
  ) as typeof fetch
  ;({ createRoot } = await import('react-dom/client'))
  ;({ EmailOtp } = await import('../components/auth/email-otp/email-otp'))
  ;({ SignIn } = await import('../components/auth/sign-in'))
  ;({ authClient } = await import('../lib/auth-client'))
  progress = await import('../lib/pending-sign-in')
  ;({ UserProfile } =
    await import('../components/auth/settings/account/user-profile'))
  ;({ AuthProvider: AuthUIProvider } =
    await import('../components/auth/auth-provider'))
  profileUI = await import('../lib/profile-ui')
  emailOtpUI = await import('../lib/auth/email-otp-plugin')
  magicLinkUI = await import('../lib/auth/magic-link-plugin')
  passkeyUI = await import('../lib/auth/passkey-plugin')
  queryTools = await import('@tanstack/react-query')
})

beforeEach(() => {
  browser.sessionStorage.clear()
  sends = 0
  signedIn = 0
  signInFails = false
  sendFails = false
  lastSend = undefined
  lastVerify = undefined
  delaySession = false
  releaseSession = undefined
  profileSession = false
  profileUserId = 'first-user'
  profileSave = undefined
  profileState = {
    name: 'Original Name',
    givenName: '',
    familyName: '',
    email: 'kyle@example.com',
    emailVerified: true,
    image: null
  }
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  releaseSession?.()
  await act(async () => root?.unmount())
  root = undefined
  profileClient?.clear()
  profileClient = undefined
  container.remove()
})

after(async () => {
  // Nanostores delays session-store unmount cleanup by one second.
  await new Promise((resolve) => setTimeout(resolve, 1100))
  globalThis.fetch = originalFetch
  await browser.happyDOM.abort()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

async function mount(withSession = false) {
  function SignInWithSession() {
    const session = authClient.useSession()
    return createElement(EmailOtp, { sessionPending: session.isPending })
  }
  profileClient ??= new queryTools.QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        AuthUIProvider,
        {
          authClient,
          queryClient: profileClient,
          navigate: ({ to }) => {
            assert.equal(to, '/profile')
            signedIn++
          },
          redirectTo: '/profile',
          emailAndPassword: { enabled: false },
          plugins: [emailOtpUI.emailOtpPlugin(), passkeyUI.passkeyPlugin()]
        },
        withSession ? createElement(SignInWithSession) : createElement(EmailOtp)
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  // The session store begins its fetch after React's mount effects run.
  if (withSession)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
}

function browserEvent(type: string, cancelable = false): Event {
  // Happy DOM's Event implements the DOM contract with a separate TS type.
  return new browser.Event(type, {
    bubbles: true,
    cancelable
  }) as unknown as Event
}

async function input(field: 'email' | 'code', value: string) {
  const element = container.querySelector<HTMLInputElement>(
    `input[name="${field}"]`
  )!
  assert.ok(element)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      browser.HTMLInputElement.prototype,
      'value'
    )!.set!.call(element, value)
    element.dispatchEvent(browserEvent('input'))
  })
}

async function submit() {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(browserEvent('submit', true))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

async function click(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text
  )
  assert.ok(button, 'Button missing: ' + text)
  await act(async () => button.click())
}

test('email-code progress survives remount without persisting the code or resending email', async () => {
  await mount()
  await input('email', 'kyle@example.com')
  await submit()
  await input('code', '123456')
  assert.equal(sends, 1)
  const pending = progress.readPendingSignIn()!
  assert.equal(pending.email, 'kyle@example.com')
  assert.deepEqual(Object.keys(pending).sort(), ['email', 'sentAt'])
  assert.ok(
    !browser.sessionStorage
      .getItem(browser.sessionStorage.key(0)!)!
      .includes('123456')
  )

  await act(async () => root!.unmount())
  await mount()
  assert.match(container.textContent!, /kyle@example.com/)
  assert.equal(
    container.querySelector<HTMLInputElement>('input[name="code"]')!.value,
    ''
  )
  assert.match(container.textContent!, /Resend in \d+s/)
  assert.equal(sends, 1, 'Restoring a form must not rotate or resend its code')
})

test('real auth-client visibility refresh retains the mounted code field and its draft', async () => {
  await mount(true)
  await input('email', 'kyle@example.com')
  await submit()
  await input('code', '123')
  const field = container.querySelector('input[name="code"]')
  const requestsBefore = sessionRequests
  delaySession = true
  await act(async () => {
    document.dispatchEvent(browserEvent('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.ok(
    sessionRequests > requestsBefore,
    'Visibility change did not trigger a session refresh'
  )
  assert.match(container.textContent!, /Checking sign-in/)
  assert.equal(container.querySelector('input[name="code"]'), field)
  await act(async () => {
    delaySession = false
    releaseSession!()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.equal(container.querySelector('input[name="code"]'), field)
  assert.equal(
    container.querySelector<HTMLInputElement>('input[name="code"]')!.value,
    '123'
  )
  assert.equal(sends, 1)
})

test('resuming recalculates cooldown and expires old codes using elapsed wall time', async () => {
  const startedAt = Date.now()
  progress.savePendingSignIn({
    email: 'kyle@example.com',
    sentAt: startedAt - 65_000
  })
  await mount()
  assert.ok(container.querySelector('input[name="code"]'))
  assert.ok(
    Array.from(container.querySelectorAll('button')).some(
      (button) => button.textContent === 'Resend' && !button.disabled
    )
  )
  const realNow = Date.now
  Date.now = () => startedAt + progress.emailCodeLifetime
  try {
    await act(async () =>
      document.dispatchEvent(browserEvent('visibilitychange'))
    )
    assert.equal(container.querySelector('input[name="code"]'), null)
    assert.match(container.textContent!, /code has expired/)
    assert.equal(progress.readPendingSignIn(), null)
    assert.equal(
      container.querySelector<HTMLInputElement>('input[name="email"]')!.value,
      'kyle@example.com'
    )
  } finally {
    Date.now = realNow
  }
})

test('changing email clears progress, failed verification preserves it, and success clears it', async () => {
  await mount()
  await input('email', 'kyle@example.com')
  await submit()
  await click('Use a different email')
  assert.equal(progress.readPendingSignIn(), null)
  assert.equal(container.querySelector('input[name="code"]'), null)
  await input('email', 'rhiann@example.com')
  await submit()
  await input('code', '123456')
  signInFails = true
  await submit()
  assert.equal(signedIn, 0)
  assert.equal(progress.readPendingSignIn()?.email, 'rhiann@example.com')
  assert.match(container.textContent!, /code could not be verified/)
  signInFails = false
  await submit()
  assert.equal(signedIn, 1)
  assert.equal(progress.readPendingSignIn(), null)
})

test('invalid, future and expired stored progress is discarded', () => {
  const key = 'spooktober.pending-email-sign-in.v1'
  for (const value of [
    'not-json',
    JSON.stringify({ email: 'kyle@example.com', sentAt: Date.now() + 60_000 }),
    JSON.stringify({
      email: 'kyle@example.com',
      sentAt: Date.now() - progress.emailCodeLifetime
    })
  ]) {
    browser.sessionStorage.setItem(key, value)
    assert.equal(progress.readPendingSignIn(), null)
  }
})

test('blocked session storage does not prevent sending or entering a code', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(browser, 'sessionStorage')
  Object.defineProperty(browser, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('Storage blocked')
    }
  })
  try {
    await mount()
    await input('email', 'kyle@example.com')
    await submit()
    await input('code', '123456')
    await submit()
    assert.equal(sends, 1)
    assert.equal(signedIn, 1)
  } finally {
    if (descriptor) Object.defineProperty(browser, 'sessionStorage', descriptor)
    else Reflect.deleteProperty(browser, 'sessionStorage')
  }
})

test('profile keeps drafts through session refresh, saves names only and isolates account changes', async () => {
  profileSession = true
  profileClient = new queryTools.QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        AuthUIProvider,
        {
          authClient,
          queryClient: profileClient,
          navigate: () => {},
          emailAndPassword: { enabled: false },
          additionalFields: profileUI.profileFields,
          avatar: profileUI.profileAvatar,
          localization: { auth: { name: 'Display name' } }
        },
        createElement(UserProfile)
      )
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const email = container.querySelector<HTMLInputElement>(
    'input[name$="email"]'
  )!
  assert.ok(email)
  assert.equal(email.readOnly, true)
  // Spooktober has no photo storage, so no avatar upload is offered.
  assert.equal(container.querySelector('input[type="file"]'), null)
  const fill = async (suffix: string, value: string) => {
    const field = container.querySelector<HTMLInputElement>(
      `input[name$="${suffix}"]`
    )!
    assert.ok(field, 'Profile field missing: ' + suffix)
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        'value'
      )!.set!.call(field, value)
      field.dispatchEvent(browserEvent('input'))
    })
  }
  await fill('name', 'Unsaved draft')
  await fill('givenName', 'Given')
  await fill('familyName', 'Family')
  // A focus refetch replaces the session object, but must not reset the
  // profile form's unsaved name fields.
  await act(async () => {
    await profileClient!.invalidateQueries()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value,
    'Unsaved draft'
  )
  await submit()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.deepEqual(profileSave, {
    name: 'Unsaved draft',
    givenName: 'Given',
    familyName: 'Family'
  })
  // Saved values stay in the form after the save completes.
  assert.equal(
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value,
    'Unsaved draft'
  )
  assert.equal(email.value, 'kyle@example.com')
  await fill('name', 'Private unfinished draft')
  profileUserId = 'second-user'
  profileState = {
    ...profileState,
    name: 'Other account',
    givenName: '',
    familyName: '',
    email: 'rhiann@example.com'
  }
  await act(async () => {
    await profileClient!.invalidateQueries()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value,
    'Other account'
  )
  assert.equal(
    container.querySelector<HTMLInputElement>('input[name$="email"]')!.value,
    'rhiann@example.com'
  )
})

test('email-code card uses the shadcn card and six code slots, normalizes email, and verifies only on submit', async () => {
  await mount()
  const card = container.querySelector('[data-slot="card"]')!
  assert.ok(card)
  assert.match(card.className, /bg-card/)
  assert.ok(
    container.querySelector('[data-slot="button"][data-variant="outline"]'),
    'Passkey button missing'
  )
  assert.equal(container.querySelector('input[type="password"]'), null)
  await input('email', ' KYLE@EXAMPLE.COM ')
  await submit()
  assert.deepEqual(lastSend, { email: 'kyle@example.com', type: 'sign-in' })
  assert.equal(
    container.querySelectorAll('[data-slot="input-otp-slot"]').length,
    6
  )
  await input('code', '123456')
  assert.equal(
    lastVerify,
    undefined,
    'Entering a code must not submit it automatically'
  )
  await submit()
  assert.deepEqual(lastVerify, { email: 'kyle@example.com', otp: '123456' })
  assert.equal(signedIn, 1)
})

test('failed send stays on the email form without saving progress or sending automatically on remount', async () => {
  await mount()
  sendFails = true
  await input('email', 'kyle@example.com')
  await submit()
  assert.ok(container.querySelector('input[name="email"]'))
  assert.equal(container.querySelector('input[name="code"]'), null)
  assert.equal(progress.readPendingSignIn(), null)
  assert.equal(sends, 1)
  await act(async () => root!.unmount())
  await mount()
  assert.equal(sends, 1)
})

test('password sign-in card links to every other method and offers no sign-up', async () => {
  profileClient = new queryTools.QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        AuthUIProvider,
        {
          authClient,
          queryClient: profileClient,
          navigate: () => {},
          basePaths: { auth: '/auth' },
          redirectTo: '/profile',
          Link: ({ href, children, ...props }) =>
            createElement('a', { href, ...props }, children),
          emailAndPassword: {
            enabled: true,
            forgotPassword: true,
            minPasswordLength: 12,
            maxPasswordLength: 128,
            rememberMe: false,
            requireEmailVerification: true
          },
          plugins: [
            emailOtpUI.emailOtpPlugin(),
            magicLinkUI.magicLinkPlugin(),
            passkeyUI.passkeyPlugin()
          ]
        },
        createElement(SignIn)
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.match(container.textContent!, /Film night sign-in/)
  assert.ok(container.querySelector('input[type="password"]'))
  const links = Array.from(container.querySelectorAll('a')).map((link) =>
    link.getAttribute('href')
  )
  // Switching method keeps the same-site return path.
  assert.ok(
    links.includes('/auth/email-otp?redirectTo=%2Fprofile'),
    links.join()
  )
  assert.ok(
    links.includes('/auth/magic-link?redirectTo=%2Fprofile'),
    links.join()
  )
  assert.ok(links.includes('/auth/forgot-password'), links.join())
  assert.ok(!links.some((href) => href?.includes('sign-up')), links.join())
  assert.match(container.textContent!, /passkey/i)
})
