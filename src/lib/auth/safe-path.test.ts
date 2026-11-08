import test from 'node:test'
import assert from 'node:assert/strict'
import { appHome, safeAppPath } from './safe-path.ts'

test('sign-in redirects stay on this site', () => {
  assert.equal(safeAppPath('/profile'), '/profile')
  assert.equal(safeAppPath('/?year=2025'), '/?year=2025')
  assert.equal(safeAppPath('/auth/sign-in#top'), '/auth/sign-in#top')
  for (const target of [
    'https://attacker.example/',
    '//attacker.example/',
    '/.//attacker.example/',
    '/./../attacker.example/..//attacker.example/',
    '/%2e//attacker.example/',
    '/\t/attacker.example/',
    '/\n/attacker.example/',
    '/\\attacker.example/',
    '/\u007f/attacker.example/',
    'javascript:alert(1)',
    ''
  ])
    assert.equal(safeAppPath(target), appHome, JSON.stringify(target))
})
