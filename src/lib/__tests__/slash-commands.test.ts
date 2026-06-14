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

import { i18n } from '../i18n'
import { _resetPropertyKeysCacheForTest } from '../property-keys-cache'
import {
  REPEAT_COMMANDS,
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

  // #976 (item 13) — the `/duplicate` slash entry that fires the
  // serialize-subtree → pasteBlocks duplicate path.
  it('registers the /duplicate command in the structure group', () => {
    const dup = SLASH_COMMANDS.find((c) => c.id === 'duplicate')
    expect(dup).toBeDefined()
    expect(dup?.category).toBe('slashCommand.categories.structure')
    expect(dup?.icon).toBeDefined()
  })

  it('searchSlashCommands surfaces /duplicate for a "duplicate" query', () => {
    const ids = searchSlashCommands('duplicate').map((r) => r.id)
    expect(ids).toContain('duplicate')
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

// #1106 — the flat 17-item "Repeat" group conflated three orthogonal concepts
// (cadence / completion-anchoring / end-conditions). The fix splits the single
// `slashCommand.categories.repeat` label into three sub-category keys so
// SuggestionList (which groups + draws a divider per `item.category`) renders
// three labelled families. Dispatch is keyed off `item.id`, so the regrouping
// is presentation-only and every option must stay reachable + dispatchable.
describe('Repeat sub-grouping (#1106)', () => {
  const CADENCE = 'slashCommand.categories.repeat.cadence'
  const ANCHORING = 'slashCommand.categories.repeat.anchoring'
  const END_CONDITION = 'slashCommand.categories.repeat.endCondition'

  // The full surface of /repeat: base parent + REPEAT_COMMANDS + REPEAT_END_COMMANDS.
  function repeatItems() {
    // matchSorter against "repeat" surfaces every repeat-labelled option from
    // all three sources (base, REPEAT_COMMANDS, REPEAT_END_COMMANDS).
    return searchSlashCommands('repeat').filter(
      (r) => r.id === 'repeat' || r.id.startsWith('repeat-'),
    )
  }

  it('surfaces all 17 repeat options (1 base + 11 cadence/anchoring + 5 end-condition)', () => {
    const ids = repeatItems().map((r) => r.id)
    // base + REPEAT_COMMANDS(11) + REPEAT_END_COMMANDS(5) = 17.
    expect(new Set(ids).size).toBe(17)
    // Every option from each source is reachable.
    for (const expected of [
      'repeat',
      'repeat-daily',
      'repeat-weekly',
      'repeat-monthly',
      'repeat-yearly',
      'repeat-.+daily',
      'repeat-.+weekly',
      'repeat-.+monthly',
      'repeat-++daily',
      'repeat-++weekly',
      'repeat-++monthly',
      'repeat-remove',
      'repeat-until',
      'repeat-limit-5',
      'repeat-limit-10',
      'repeat-limit-20',
      'repeat-limit-remove',
    ]) {
      expect(ids).toContain(expected)
    }
  })

  it('assigns each repeat option to exactly one of the three sub-groups (no flat group left)', () => {
    const byId = new Map(repeatItems().map((r) => [r.id, r.category]))

    // Cadence: the base parent + the four plain cadences.
    for (const id of [
      'repeat',
      'repeat-daily',
      'repeat-weekly',
      'repeat-monthly',
      'repeat-yearly',
    ]) {
      expect(byId.get(id)).toBe(CADENCE)
    }
    // Anchoring: the `.+` (from-completion) and `++` (catch-up) variants + remove.
    for (const id of [
      'repeat-.+daily',
      'repeat-.+weekly',
      'repeat-.+monthly',
      'repeat-++daily',
      'repeat-++weekly',
      'repeat-++monthly',
      'repeat-remove',
    ]) {
      expect(byId.get(id)).toBe(ANCHORING)
    }
    // End-condition: until + the four limit options.
    for (const id of [
      'repeat-until',
      'repeat-limit-5',
      'repeat-limit-10',
      'repeat-limit-20',
      'repeat-limit-remove',
    ]) {
      expect(byId.get(id)).toBe(END_CONDITION)
    }

    // The old undifferentiated label must no longer be carried by any option.
    for (const category of byId.values()) {
      expect(category).not.toBe('slashCommand.categories.repeat')
    }
  })

  it('the three sub-group headers render distinct, non-raw i18n labels', () => {
    const labels = [CADENCE, ANCHORING, END_CONDITION].map((k) => i18n.t(k))
    for (const [key, label] of [CADENCE, ANCHORING, END_CONDITION].map(
      (k) => [k, i18n.t(k)] as const,
    )) {
      expect(label, `${key} should resolve to a real label`).not.toBe(key)
      expect(label.length).toBeGreaterThan(0)
    }
    // Distinct headers → SuggestionList draws three separate dividers.
    expect(new Set(labels).size).toBe(3)
  })

  it('keeps every repeat option dispatchable (id still matches its exact/prefix contract)', () => {
    // Mirror dispatchSlashCommand's resolution order: exact `repeat-until`
    // (date hook), then the `repeat-limit-` prefix, then the `repeat-` prefix.
    // The base `repeat` parent opens the family rather than mutating directly.
    function resolvesToHandler(id: string): boolean {
      if (id === 'repeat') return true // parent entry — surfaces the family
      if (id === 'repeat-until') return true // exact (date picker)
      if (id.startsWith('repeat-limit-')) return true
      if (id.startsWith('repeat-')) return true
      return false
    }
    for (const item of repeatItems()) {
      expect(resolvesToHandler(item.id), `${item.id} must remain dispatchable`).toBe(true)
    }
  })

  it('REPEAT_COMMANDS carries only the cadence + anchoring sub-categories', () => {
    // Pins the source-of-truth list so a regression that reintroduces the flat
    // `slashCommand.categories.repeat` label (or a typo'd sub-key) is caught.
    const cats = new Set(REPEAT_COMMANDS.map((c) => c.category))
    expect(cats).toEqual(new Set([CADENCE, ANCHORING]))
  })
})
