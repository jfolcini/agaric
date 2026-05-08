/**
 * Tests for `src/lib/slash-commands.ts` `searchPropertyKeys`
 * (PEND-35 Tier 2.5).
 *
 * The fix routes `searchPropertyKeys` through the shared module-level
 * cache in `src/lib/property-keys-cache.ts` instead of firing a fresh
 * `list_property_keys` IPC on every keystroke. This file pins that
 * contract: many simulated keystrokes against the cached helper must
 * fire ONE IPC.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (): Promise<() => void> => () => {}),
}))

import { _resetPropertyKeysCacheForTest } from '../property-keys-cache'
import { searchPropertyKeys } from '../slash-commands'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  _resetPropertyKeysCacheForTest()
  mockedInvoke.mockResolvedValue(['project', 'effort', 'assignee', 'priority'])
})

afterEach(() => {
  _resetPropertyKeysCacheForTest()
})

function listPropertyKeysInvocationCount(): number {
  return mockedInvoke.mock.calls.filter((c) => c[0] === 'list_property_keys').length
}

describe('searchPropertyKeys (PEND-35 Tier 2.5)', () => {
  it('fires one IPC across many keystrokes (cached helper, not direct listPropertyKeys)', async () => {
    // Simulate the user typing "p", "pr", "pri", "prio", "prior".
    const queries = ['p', 'pr', 'pri', 'prio', 'prior']
    const all = await Promise.all(queries.map((q) => searchPropertyKeys(q)))

    expect(listPropertyKeysInvocationCount()).toBe(1)
    // Each query must be filtered against the same cached key list.
    for (const result of all) {
      expect(result.every((r) => r.id.startsWith('p'))).toBe(true)
    }
  })

  it('returns matching keys filtered by the query', async () => {
    const results = await searchPropertyKeys('eff')
    expect(results).toEqual([{ id: 'effort', label: 'effort' }])
  })

  it('returns every cached key when the query is empty', async () => {
    const results = await searchPropertyKeys('')
    expect(results).toHaveLength(4)
  })

  it('serial keystrokes after the first reuse the cached array — still one IPC', async () => {
    await searchPropertyKeys('p')
    await searchPropertyKeys('pr')
    await searchPropertyKeys('pri')
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  it('returns empty array on IPC failure (does not throw)', async () => {
    mockedInvoke.mockReset()
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failure'))
    const results = await searchPropertyKeys('x')
    expect(results).toEqual([])
  })
})
