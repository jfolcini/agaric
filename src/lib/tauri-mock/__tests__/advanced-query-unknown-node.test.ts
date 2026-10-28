/**
 * An unknown `FilterExpr` node kind is refused, as the backend's serde refuses
 * it (#6149): the mock must not match every row, nor pass the gate, for one.
 */

import { describe, expect, it } from 'vitest'

import { dispatch, metaRowMatchesExpr, type PageMetaRow } from '@/lib/tauri-mock/handlers'
import { assertQueryFilterLeaves } from '@/lib/tauri-mock/handlers/shared'

const ROW = {
  id: 'B'.padStart(26, '0'),
  blockType: 'page',
  priority: null,
} as unknown as PageMetaRow

const UNKNOWN = { type: 'Xor', children: [] }
const REFUSED = expect.objectContaining({ kind: 'validation', code: 'InvalidFilter' })

describe('unknown FilterExpr node kind (#6149)', () => {
  it('metaRowMatchesExpr throws instead of matching', () => {
    expect(() => metaRowMatchesExpr(ROW, UNKNOWN)).toThrow(REFUSED)
  })

  it('metaRowMatchesExpr throws for an unknown node nested under Not', () => {
    expect(() => metaRowMatchesExpr(ROW, { type: 'Not', child: UNKNOWN })).toThrow(REFUSED)
  })

  it('assertQueryFilterLeaves throws at the top and when nested', () => {
    expect(() => assertQueryFilterLeaves(UNKNOWN)).toThrow(REFUSED)
    expect(() => assertQueryFilterLeaves({ type: 'And', children: [UNKNOWN] })).toThrow(REFUSED)
  })

  it('run_advanced_query refuses the request', () => {
    expect(() => dispatch('run_advanced_query', { request: { filter: UNKNOWN } })).toThrow(REFUSED)
  })
})
