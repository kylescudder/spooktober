import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCodeEmail, renderLinkEmail } from './auth-email.ts'

const origin = 'https://spooktober.auth.test'

test('auth emails are branded, escape links and only link to this site', () => {
  const code = renderCodeEmail(origin, '123456')
  assert.equal(code.subject, '123456 is your Spooktober sign-in code')
  assert.ok(code.html.includes(`src="${origin}/email-logo.png"`))
  assert.ok(code.html.includes('width="40"'))
  assert.ok(code.html.includes('Spooktober'))
  assert.ok(code.html.includes('#ed9751'))
  assert.ok(code.html.includes('Halloween film nights'))
  assert.ok(code.html.includes('>123456<'))
  assert.ok(code.text.includes('123456'))
  assert.throws(() => renderCodeEmail(origin, '12345<'))
  assert.throws(() => renderCodeEmail(origin, '1234567'))

  const url = `${origin}/api/auth/magic-link/verify?token=abc&callbackURL=%2F"x`
  const link = renderLinkEmail(origin, 'magic-link', url)
  assert.equal(link.subject, 'Your Spooktober sign-in link')
  // URL parsing percent-encodes the quote; & is HTML-escaped in attributes.
  assert.ok(link.html.includes('token=abc&amp;callbackURL=%2F%22x'))
  assert.ok(!link.html.includes('callbackURL=%2F"x'))
  assert.ok(link.text.includes(new URL(url).href))
  assert.ok(link.html.includes('10 minutes'))

  const reset = renderLinkEmail(
    origin,
    'reset-password',
    `${origin}/api/auth/reset-password/t`
  )
  assert.equal(reset.subject, 'Set your Spooktober password')
  assert.ok(reset.html.includes('30 minutes'))

  assert.throws(
    () =>
      renderLinkEmail(origin, 'magic-link', 'https://attacker.example/verify'),
    /Unexpected sign-in link origin/
  )
})
