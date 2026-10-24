import test from 'node:test'
import assert from 'node:assert/strict'
import { watchlistSearch } from './years.ts'

test('year URLs accept whole calendar years and leave invalid or missing values at the current-year default', () => {
  assert.deepEqual(watchlistSearch({ year: '2025' }), { year: 2025 })
  assert.deepEqual(watchlistSearch({ year: 2031 }), { year: 2031 })
  for (const year of [
    undefined,
    null,
    '',
    'invalid',
    '2026.5',
    2026.5,
    1899,
    10000,
    [2026],
    true
  ]) {
    assert.deepEqual(watchlistSearch({ year }), { year: undefined })
  }
})
