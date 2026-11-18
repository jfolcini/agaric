/**
 * #6758 — the mock's `datetime` value type: a definition of it, its canonical
 * UTC value in `value_date`, a type change into and out of it, and the
 * day-only operand that compares a datetime value as the device's local day.
 * The backend's conformance fixture (create, set, read back) pins the first
 * two against the real commands; the rest mirror the issue's spec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { propertyCompareMatches, propertyEqMatches } from '@/lib/tauri-mock/handlers/shared'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const SPACE = SEED_IDS.SPACE_PERSONAL
const X = SEED_IDS.BLOCK_GS_1
const Y = SEED_IDS.BLOCK_GS_2
const Z = SEED_IDS.BLOCK_GS_3

function call<T>(cmd: string, args: Record<string, unknown>): T {
  return dispatch(cmd, args) as T
}

function rejectionOf(fn: () => unknown): { kind: string; message: string } {
  try {
    fn()
  } catch (err) {
    return err as { kind: string; message: string }
  }
  throw new Error('expected a rejection')
}

const EMPTY = { value_text: null, value_num: null, value_date: null, value_ref: null }

function set(blockId: string, key: string, value: Record<string, unknown>): unknown {
  return call('set_property', { blockId, key, value: { ...EMPTY, value_bool: null, ...value } })
}

function rowOf(blockId: string, key: string): Record<string, unknown> | undefined {
  return call<Array<Record<string, unknown>>>('get_properties', { blockId }).find(
    (r) => r['key'] === key,
  )
}

function declare(key: string, valueType: string): void {
  call('create_property_def', { spaceId: SPACE, key, valueType, options: null })
}

function change(key: string, valueType: string, acknowledged: Record<string, number>): void {
  call('change_property_type', { spaceId: SPACE, key, valueType, options: null, acknowledged })
}

beforeEach(() => {
  seedBlocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a datetime definition and its value', () => {
  it('declares a datetime key and keeps its canonical value in value_date', () => {
    declare('meeting', 'datetime')
    const defs = call<{ items: Array<Record<string, unknown>> }>('list_property_defs', {
      spaceId: SPACE,
    })
    expect(defs.items.find((d) => d['key'] === 'meeting')).toMatchObject({
      value_type: 'datetime',
    })
    set(X, 'meeting', { value_date: '2026-11-14T08:30Z' })
    expect(rowOf(X, 'meeting')).toMatchObject({ ...EMPTY, value_date: '2026-11-14T08:30Z' })
  })

  it('refuses a day alone or a non-canonical time under a datetime key', () => {
    declare('meeting', 'datetime')
    expect(rejectionOf(() => set(X, 'meeting', { value_date: '2026-11-14' })).kind).toBe(
      'validation',
    )
    expect(rejectionOf(() => set(X, 'meeting', { value_date: '2026-11-14 09:30' })).kind).toBe(
      'validation',
    )
    expect(rowOf(X, 'meeting')).toBeUndefined()
  })

  it('refuses a datetime under a date key', () => {
    declare('due', 'date')
    expect(rejectionOf(() => set(X, 'due', { value_date: '2026-11-14T08:30Z' })).kind).toBe(
      'validation',
    )
  })
})

describe('changing a key to or from datetime', () => {
  it('converts a text a datetime reads, never a day alone', () => {
    declare('when', 'text')
    set(X, 'when', { value_text: '2026-11-14T09:30+01:00' })
    set(Y, 'when', { value_text: '2026-11-14' })
    set(Z, 'when', { value_text: 'soon' })
    expect(
      call('preview_property_type_change', {
        spaceId: SPACE,
        key: 'when',
        valueType: 'datetime',
        options: null,
      }),
    ).toEqual({ converted: 1, unfit: 2 })
    change('when', 'datetime', { converted: 1, unfit: 2 })
    expect(rowOf(X, 'when')).toMatchObject({ value_text: null, value_date: '2026-11-14T08:30Z' })
    expect(rowOf(Y, 'when')).toMatchObject({ value_text: '2026-11-14', value_date: null })
  })

  /** Berlin is UTC+1 in November; a worker that ignores `TZ` (Stryker's threads) skips. */
  function inBerlin(): boolean {
    vi.stubEnv('TZ', 'Europe/Berlin')
    return new Date(Date.UTC(2026, 10, 13, 23, 30)).getDate() === 14
  }

  function values(key: string, valueType: string, kind: string): Array<Record<string, unknown>> {
    return call<{ items: Array<Record<string, unknown>> }>('list_property_type_change_values', {
      spaceId: SPACE,
      key,
      valueType,
      options: null,
      kind,
      cursor: null,
      limit: 50,
    }).items
  }

  it('a datetime becomes its local day under date', () => {
    if (!inBerlin()) return
    declare('when', 'datetime')
    set(X, 'when', { value_date: '2026-11-13T23:30Z' })
    expect(values('when', 'date', 'converted')).toEqual([
      expect.objectContaining({ block_id: X, value: '2026-11-13T23:30Z', converted: '2026-11-14' }),
    ])
    change('when', 'date', { converted: 1, unfit: 0 })
    expect(rowOf(X, 'when')).toMatchObject({ value_text: null, value_date: '2026-11-14' })
  })

  it('a datetime becomes its local time with its offset under text and url', () => {
    if (!inBerlin()) return
    declare('when', 'datetime')
    set(X, 'when', { value_date: '2026-11-14T08:30Z' })
    expect(values('when', 'url', 'converted')).toEqual([
      expect.objectContaining({ converted: '2026-11-14T09:30+01:00' }),
    ])
    change('when', 'text', { converted: 1, unfit: 0 })
    expect(rowOf(X, 'when')).toMatchObject({
      value_text: '2026-11-14T09:30+01:00',
      value_date: null,
    })
  })

  it('a day is never promoted to a datetime: it does not fit', () => {
    declare('when', 'date')
    set(X, 'when', { value_date: '2026-11-14' })
    expect(
      call('preview_property_type_change', {
        spaceId: SPACE,
        key: 'when',
        valueType: 'datetime',
        options: null,
      }),
    ).toEqual({ converted: 0, unfit: 1 })
    change('when', 'datetime', { converted: 0, unfit: 1 })
    expect(rowOf(X, 'when')).toMatchObject({ value_text: '2026-11-14', value_date: null })
  })

  it('a text key holding the canonical string is not read as a datetime under date', () => {
    declare('when', 'text')
    set(X, 'when', { value_text: '2026-11-14T08:30Z' })
    expect(
      call('preview_property_type_change', {
        spaceId: SPACE,
        key: 'when',
        valueType: 'date',
        options: null,
      }),
    ).toEqual({ converted: 0, unfit: 1 })
  })
})

describe('a datetime in Markdown', () => {
  it('is written as its local time with its offset', () => {
    vi.stubEnv('TZ', 'Europe/Berlin')
    // A worker thread ignores `process.env.TZ` (the Stryker runner's `threads` pool).
    if (new Date(Date.UTC(2026, 10, 14, 8, 30)).getHours() !== 9) return
    declare('when', 'datetime')
    set(X, 'when', { value_date: '2026-11-14T08:30Z' })
    const buffer = call<{ text: string }>('get_page_buffer', {
      pageId: SEED_IDS.PAGE_GETTING_STARTED,
    })
    expect(buffer.text).toContain('when:: 2026-11-14T09:30+01:00')
  })
})

describe('a day-only operand on a datetime value is the local day', () => {
  // 23:30 UTC on the 13th is 00:30 on the 14th in Berlin (UTC+1).
  const held = { value_date: '2026-11-13T23:30Z' }
  const day = (value: string) => ({ type: 'Date', value })

  it('matches the day it falls on locally, and orders against its bounds', () => {
    vi.stubEnv('TZ', 'Europe/Berlin')
    // A worker thread ignores `process.env.TZ` (the Stryker runner's `threads` pool).
    if (new Date(Date.UTC(2026, 10, 13, 23, 30)).getDate() !== 14) return
    expect(propertyEqMatches(held, day('2026-11-14'))).toBe(true)
    expect(propertyEqMatches(held, day('2026-11-13'))).toBe(false)
    expect(propertyCompareMatches(held, 'Gte', day('2026-11-14'))).toBe(true)
    expect(propertyCompareMatches(held, 'Gt', day('2026-11-14'))).toBe(false)
    expect(propertyCompareMatches(held, 'Gt', day('2026-11-13'))).toBe(true)
    expect(propertyCompareMatches(held, 'Lt', day('2026-11-14'))).toBe(false)
    expect(propertyCompareMatches(held, 'Lte', day('2026-11-14'))).toBe(true)
    expect(propertyCompareMatches(held, 'Lt', day('2026-11-15'))).toBe(true)
  })

  it('compares a datetime operand as the instant it is', () => {
    expect(propertyEqMatches(held, day('2026-11-13T23:30Z'))).toBe(true)
    expect(propertyCompareMatches(held, 'Lt', day('2026-11-13T23:31Z'))).toBe(true)
  })
})
