import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts
} from '@tanstack/react-router'
import { AuthMessage } from '../components/auth-message'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Spooktober · Kyle & Rhiann' },
      {
        name: 'description',
        content:
          'Our shared Halloween film watchlist. Pick a fright, settle in, and tick it off together.'
      },
      { name: 'robots', content: 'noindex, nofollow' }
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg' }
    ]
  }),
  component: Outlet,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <AuthMessage title='This page has wandered off.'>
      <Link to='/'>Back to our film nights</Link>
    </AuthMessage>
  ),
  errorComponent: () => (
    <AuthMessage title='Our film nights hit a snag.'>
      <p>Please reload the page and try again.</p>
    </AuthMessage>
  )
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang='en'>
      <head>
        <HeadContent />
      </head>
      <body className='antialiased'>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
