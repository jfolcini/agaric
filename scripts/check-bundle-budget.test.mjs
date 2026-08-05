import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateBudgets, TRACKED } from './check-bundle-budget.mjs'
import { VENDOR_CHUNK_GROUPS } from './vendor-chunk-groups.ts'

test('every declared vendor chunk is tracked by the budget gate', () => {
  assert.equal(TRACKED[0], 'index')
  assert.deepEqual(
    TRACKED.slice(1),
    VENDOR_CHUNK_GROUPS.map((group) => group.name),
  )
})

test('sizes within complete budgets pass evaluation', () => {
  const result = evaluateBudgets({ index: 100, vendor: 40 }, { index: 110, vendor: 50 }, [
    'index',
    'vendor',
  ])

  assert.deepEqual(result, { failures: [], missing: [], ok: true })
})

test('a declared chunk with no checked-in budget fails evaluation', () => {
  const result = evaluateBudgets({ index: 100, 'declared-vendor': 40 }, { index: 110 }, [
    'index',
    'declared-vendor',
  ])

  assert.equal(result.ok, false)
  assert.deepEqual(result.failures, [])
  assert.equal(result.missing.length, 1)
  assert.match(result.missing[0], /budget for tracked chunk "declared-vendor" missing/)
})

test('a stale budget for an undeclared chunk fails evaluation', () => {
  const result = evaluateBudgets({ index: 100 }, { index: 110, 'retired-vendor': 30 }, ['index'])

  assert.equal(result.ok, false)
  assert.match(result.missing[0], /stale budget for undeclared chunk "retired-vendor"/)
})

test('duplicate declared chunk names fail evaluation', () => {
  const result = evaluateBudgets({ index: 100, vendor: 40 }, { index: 110, vendor: 50 }, [
    'index',
    'vendor',
    'vendor',
  ])

  assert.equal(result.ok, false)
  assert.match(result.missing[0], /tracked chunk name "vendor" is declared more than once/)
})
