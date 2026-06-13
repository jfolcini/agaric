/**
 * Tabs store persistence tests.
 *
 * CR-PERSIST — covers the coercing `migrate` seam wired into the persist
 * middleware. The migrate is the safety net for a future `version` bump
 * (without it zustand silently discards the persisted blob to defaults,
 * losing every open tab) and doubles as corruption defense for a
 * malformed `localStorage` payload. We reach it through the same public
 * seam zustand uses on rehydrate.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { useNavigationStore } from '../navigation'
import { useRecentPagesStore } from '../recent-pages'
import { MAX_PAGE_STACK_DEPTH, selectPageStack, useTabsStore } from '../tabs'

const migrate = useTabsStore.persist.getOptions().migrate

type PersistedTabs = {
  tabs: Array<{ id: string; pageStack: Array<{ pageId: string; title: string }>; label: string }>
  activeTabIndex: number
  tabsBySpace: Record<string, unknown[]>
  activeTabIndexBySpace: Record<string, number>
}

function run(blob: unknown): PersistedTabs {
  return migrate?.(blob, 0) as PersistedTabs
}

describe('tabs persist migrate', () => {
  it('is wired into the persist options', () => {
    expect(typeof migrate).toBe('function')
  })

  it('falls back to a single empty tab when the blob is null/undefined', () => {
    const result = run(undefined)
    expect(result.tabs).toEqual([{ id: '0', pageStack: [], label: '' }])
    expect(result.activeTabIndex).toBe(0)
    expect(result.tabsBySpace).toEqual({})
    expect(result.activeTabIndexBySpace).toEqual({})
  })

  it('preserves a well-formed persisted blob round-trip', () => {
    const blob = {
      tabs: [{ id: '3', pageStack: [{ pageId: 'P1', title: 'One' }], label: 'One' }],
      activeTabIndex: 0,
      tabsBySpace: {
        SPACE_A: [{ id: '3', pageStack: [{ pageId: 'P1', title: 'One' }], label: 'One' }],
      },
      activeTabIndexBySpace: { SPACE_A: 0 },
    }
    const result = run(blob)
    expect(result.tabs).toEqual(blob.tabs)
    expect(result.tabsBySpace).toEqual(blob.tabsBySpace)
    expect(result.activeTabIndexBySpace).toEqual({ SPACE_A: 0 })
  })

  it('drops tabs missing a string id and invalid pageStack entries', () => {
    const blob = {
      tabs: [
        { id: 7, pageStack: [], label: 'bad-id' },
        {
          id: '1',
          pageStack: [
            { pageId: 'P1', title: 'ok' },
            { pageId: 5, title: 'bad' },
            { title: 'no-id' },
            'garbage',
          ],
          label: 'kept',
        },
      ],
    }
    const result = run(blob)
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.id).toBe('1')
    expect(result.tabs[0]?.pageStack).toEqual([{ pageId: 'P1', title: 'ok' }])
  })

  it('defaults a missing label to empty string', () => {
    const result = run({ tabs: [{ id: '2', pageStack: [] }] })
    expect(result.tabs[0]?.label).toBe('')
  })

  it('coerces a negative or non-integer activeTabIndex to 0', () => {
    expect(run({ activeTabIndex: -1 }).activeTabIndex).toBe(0)
    expect(run({ activeTabIndex: 1.5 }).activeTabIndex).toBe(0)
    expect(run({ activeTabIndex: 'x' }).activeTabIndex).toBe(0)
    expect(run({ activeTabIndex: 2 }).activeTabIndex).toBe(2)
  })

  it('drops empty / non-array per-space tab slices and invalid indices', () => {
    const blob = {
      tabsBySpace: {
        SPACE_A: [{ id: '1', pageStack: [], label: '' }],
        SPACE_EMPTY: [],
        SPACE_BAD: 'not-an-array',
      },
      activeTabIndexBySpace: { SPACE_A: 0, SPACE_BAD: -2, SPACE_X: 'y' },
    }
    const result = run(blob)
    expect(Object.keys(result.tabsBySpace)).toEqual(['SPACE_A'])
    expect(result.activeTabIndexBySpace).toEqual({ SPACE_A: 0 })
  })

  it('ignores a non-object blob', () => {
    const result = run('corrupt')
    expect(result.tabs).toEqual([{ id: '0', pageStack: [], label: '' }])
    expect(result.tabsBySpace).toEqual({})
  })

  it('drops a non-integer per-space index', () => {
    const result = run({ activeTabIndexBySpace: { SPACE_A: 0, SPACE_FLOAT: 1.5 } })
    expect(result.activeTabIndexBySpace).toEqual({ SPACE_A: 0 })
  })

  it('does not pollute Object.prototype via a __proto__ key', () => {
    const malicious = JSON.parse('{"tabsBySpace": {"__proto__": [{"id": "x", "pageStack": []}]}}')
    const result = run(malicious)
    expect(({} as Record<string, unknown>)['id']).toBeUndefined()
    expect(Object.hasOwn(result.tabsBySpace, '__proto__')).toBe(false)
  })

  it('is idempotent — coercing an already-valid blob is a no-op', () => {
    const blob = {
      tabs: [{ id: '3', pageStack: [{ pageId: 'P1', title: 'One' }], label: 'One' }],
      activeTabIndex: 0,
      tabsBySpace: {
        SPACE_A: [{ id: '3', pageStack: [{ pageId: 'P1', title: 'One' }], label: 'One' }],
      },
      activeTabIndexBySpace: { SPACE_A: 0 },
    }
    const once = run(blob)
    const twice = run(once)
    expect(twice).toEqual(once)
  })
})

// ---------------------------------------------------------------------------
// CR-PERSIST (#823) — coercing `merge`. zustand's persist middleware only
// invokes `migrate` when the stored version DIFFERS from `options.version`.
// A corrupt blob that still carries the CURRENT `version: 1` (or a
// non-numeric version) bypasses `migrate` entirely and is handed RAW to the
// default shallow `merge`, letting a malformed `localStorage` payload reach
// the tab reducers / selectors. The coercion therefore also lives in a
// custom `merge` — this block pins that seam (mirrors navigation.test.ts).
// ---------------------------------------------------------------------------
describe('tabs persist merge (#823 — same-version blobs bypass migrate)', () => {
  const options = useTabsStore.persist.getOptions()
  const defaults = {
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  } as unknown as Parameters<NonNullable<typeof options.merge>>[1]

  function mergeRun(blob: unknown): PersistedTabs {
    return options.merge?.(blob, defaults) as unknown as PersistedTabs
  }

  it('is wired into the persist options', () => {
    expect(typeof options.merge).toBe('function')
  })

  // The headline #823 case: a same-version (v1) blob carrying garbage
  // fields. Previously this flowed raw through the default shallow merge.
  it('coerces a corrupt same-version blob instead of passing it through', () => {
    const result = mergeRun({
      tabs: [
        { id: 7, pageStack: [], label: 'bad-id' },
        {
          id: '1',
          pageStack: [{ pageId: 'P1', title: 'ok' }, { pageId: 5, title: 'bad' }, 'garbage'],
          label: 'kept',
        },
      ],
      activeTabIndex: -3,
      tabsBySpace: { SPACE_OK: [{ id: '1', pageStack: [], label: '' }], SPACE_BAD: 'not-an-array' },
      activeTabIndexBySpace: { SPACE_OK: 0, SPACE_FLOAT: 1.5 },
    })
    // garbage tab dropped, bad pageStack entries dropped
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.id).toBe('1')
    expect(result.tabs[0]?.pageStack).toEqual([{ pageId: 'P1', title: 'ok' }])
    // negative index repaired to 0
    expect(result.activeTabIndex).toBe(0)
    // invalid per-space slots dropped
    expect(Object.keys(result.tabsBySpace)).toEqual(['SPACE_OK'])
    expect(result.activeTabIndexBySpace).toEqual({ SPACE_OK: 0 })
  })

  it('passes a well-formed blob through unchanged', () => {
    const blob = {
      tabs: [{ id: '3', pageStack: [{ pageId: 'P1', title: 'One' }], label: 'One' }],
      activeTabIndex: 0,
      tabsBySpace: {
        SPACE_A: [{ id: '3', pageStack: [{ pageId: 'P1', title: 'One' }], label: 'One' }],
      },
      activeTabIndexBySpace: { SPACE_A: 0 },
    }
    const result = mergeRun(blob)
    expect(result.tabs).toEqual(blob.tabs)
    expect(result.tabsBySpace).toEqual(blob.tabsBySpace)
    expect(result.activeTabIndexBySpace).toEqual({ SPACE_A: 0 })
  })

  it('falls back to a single empty tab when storage is empty (undefined persisted)', () => {
    const result = mergeRun(undefined)
    expect(result.tabs).toEqual([{ id: '0', pageStack: [], label: '' }])
    expect(result.activeTabIndex).toBe(0)
    expect(result.tabsBySpace).toEqual({})
    expect(result.activeTabIndexBySpace).toEqual({})
  })

  it('does not throw on a wholly non-object blob', () => {
    expect(() => mergeRun('corrupt')).not.toThrow()
    expect(mergeRun('corrupt').tabs).toEqual([{ id: '0', pageStack: [], label: '' }])
  })

  // The corrupt-blob path actually demonstrated end-to-end: seed
  // localStorage with a same-version blob and rehydrate the live store.
  it('end-to-end: rehydrating a same-version corrupt blob repairs the store', () => {
    const STORAGE_KEY = 'agaric:tabs'
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          tabs: [{ id: 9, pageStack: [{ pageId: 5, title: 'bad' }], label: 'x' }],
          activeTabIndex: -1,
          tabsBySpace: { SPACE_BAD: 'not-an-array' },
          activeTabIndexBySpace: { SPACE_BAD: 'y' },
        },
        version: 1,
      }),
    )

    expect(() => useTabsStore.persist.rehydrate()).not.toThrow()

    const state = useTabsStore.getState()
    // The bad tab (numeric id) was dropped → fell back to a single empty tab.
    expect(state.tabs).toEqual([{ id: '0', pageStack: [], label: '' }])
    expect(state.activeTabIndex).toBe(0)
    expect(state.tabsBySpace).toEqual({})
    expect(state.activeTabIndexBySpace).toEqual({})

    localStorage.removeItem(STORAGE_KEY)
  })
})

// ---------------------------------------------------------------------------
// #754 — pageStack depth cap. `navigateToPage` only dedups the SAME page at
// the top, so a long browsing session previously grew the stack (and the
// persisted blob) without bound. The cap drops the OLDEST entry.
// ---------------------------------------------------------------------------

describe('pageStack depth cap (#754)', () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      tabsBySpace: {},
      activeTabIndexBySpace: {},
    })
    useNavigationStore.setState({ currentView: 'pages', selectedBlockId: null })
    useRecentPagesStore.setState({ recentPages: [], recentPagesBySpace: {} })
  })

  it('caps the active tab stack at MAX_PAGE_STACK_DEPTH by dropping the oldest entries', () => {
    const overshoot = 5
    for (let i = 0; i < MAX_PAGE_STACK_DEPTH + overshoot; i++) {
      useTabsStore.getState().navigateToPage(`PAGE_${i}`, `Title ${i}`)
    }

    const stack = selectPageStack(useTabsStore.getState())
    expect(stack).toHaveLength(MAX_PAGE_STACK_DEPTH)
    // Newest entry stays on top…
    const last = MAX_PAGE_STACK_DEPTH + overshoot - 1
    expect(stack[stack.length - 1]).toEqual({ pageId: `PAGE_${last}`, title: `Title ${last}` })
    // …and the oldest entries were dropped (drop-oldest, not drop-newest).
    expect(stack[0]).toEqual({ pageId: `PAGE_${overshoot}`, title: `Title ${overshoot}` })
  })

  it('keeps the tab label pointing at the top of the capped stack', () => {
    for (let i = 0; i < MAX_PAGE_STACK_DEPTH + 1; i++) {
      useTabsStore.getState().navigateToPage(`PAGE_${i}`, `Title ${i}`)
    }
    const state = useTabsStore.getState()
    expect(state.tabs[state.activeTabIndex]?.label).toBe(`Title ${MAX_PAGE_STACK_DEPTH}`)
  })

  it('does not truncate a stack below the cap', () => {
    useTabsStore.getState().navigateToPage('PAGE_A', 'A')
    useTabsStore.getState().navigateToPage('PAGE_B', 'B')

    const stack = selectPageStack(useTabsStore.getState())
    expect(stack).toEqual([
      { pageId: 'PAGE_A', title: 'A' },
      { pageId: 'PAGE_B', title: 'B' },
    ])
  })
})
