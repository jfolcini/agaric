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
import {
  SLASH_COMMANDS,
  TURN_INTO_COMMANDS,
  TURN_INTO_OPTIONS,
  searchPropertyKeys,
  searchSlashCommands,
} from '../slash-commands'

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

describe('SLASH_COMMANDS catalog', () => {
  it('registers the block-ref command in the references group (#213 PR 4)', () => {
    const blockRef = SLASH_COMMANDS.find((c) => c.id === 'block-ref')
    expect(blockRef).toBeDefined()
    expect(blockRef?.category).toBe('slashCommand.categories.references')
    expect(blockRef?.icon).toBeDefined()
  })

  it('has unique command ids', () => {
    const ids = SLASH_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // #264 — "Turn into" parent slash entry.
  it('registers the /turn parent command in the structure group', () => {
    const turn = SLASH_COMMANDS.find((c) => c.id === 'turn')
    expect(turn).toBeDefined()
    expect(turn?.category).toBe('slashCommand.categories.structure')
    expect(turn?.icon).toBeDefined()
  })
})

describe('TURN_INTO commands (#264)', () => {
  it('exposes the full block-type option set', () => {
    expect(TURN_INTO_OPTIONS.map((o) => o.blockType)).toEqual([
      'paragraph',
      'h1',
      'h2',
      'h3',
      'quote',
      'code',
      'numbered-list',
      'callout',
    ])
  })

  it('every option id is prefixed turn- and the catalog mirrors the options', () => {
    for (const opt of TURN_INTO_OPTIONS) {
      expect(opt.id).toMatch(/^turn-/)
    }
    expect(TURN_INTO_COMMANDS.map((c) => c.id)).toEqual(TURN_INTO_OPTIONS.map((o) => o.id))
  })

  it('searchSlashCommands surfaces the parent + expanded options for a /turn query', () => {
    const ids = searchSlashCommands('turn').map((r) => r.id)
    expect(ids).toContain('turn')
    expect(ids).toContain('turn-paragraph')
    expect(ids).toContain('turn-h1')
    expect(ids).toContain('turn-code')
    expect(ids).toContain('turn-callout')
  })

  it('does not surface turn options for an unrelated query', () => {
    const ids = searchSlashCommands('priority').map((r) => r.id)
    expect(ids).not.toContain('turn-paragraph')
  })

  // #264 regression — the option labels embed their target-type name
  // ("TURN INTO Heading 1"), so a type-name query like `/heading`, `/quote`, or
  // `/code` must NOT pull in the turn-* duplicates alongside the canonical type
  // commands (which would also break strict-mode `hasText` locators in e2e).
  it.each(['heading', 'quote', 'code'])(
    'does not surface turn options for the type-name query %p',
    (query) => {
      const ids = searchSlashCommands(query).map((r) => r.id)
      expect(ids.some((id) => id.startsWith('turn-'))).toBe(false)
    },
  )
})
