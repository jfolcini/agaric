/**
 * Cross-store invariant suite (#2465).
 *
 * `docs/architecture/frontend.md` and `docs/architecture/editor-and-content.md`
 * state two of the store layer's load-bearing rules only as prose:
 *
 *   1. "Modes are mutually exclusive — you're either editing one block or
 *      selecting many" (editor-and-content.md § Multi-selection): a non-null
 *      `useBlockStore.focusedBlockId` (the active-editor state) and a
 *      non-empty `selectedBlockIds` (the multi-selection) must never coexist.
 *   2. Selection lifecycle: `selectedBlockIds` must clear on every documented
 *      trigger — entering edit mode (rule 1, restated as a lifecycle event),
 *      and a page-context change (view switch, page navigation, page-stack
 *      pop) per the #2438/#2451 fix pinned in `blocks.ts`.
 *
 * This file drives the REAL `useBlockStore` / `useNavigationStore` /
 * `useTabsStore` singletons (no store mocking — per `src/stores/__tests__/
 * AGENTS.md` "Global stores" convention) through every action that can touch
 * focus or selection and asserts the invariant holds after each one. None of
 * these stores call `invoke()`, so no IPC mock is needed here (see
 * `src/stores/__tests__/blocks.test.ts` for the same no-mock pattern).
 *
 * `blocks.test.ts` already covers each action's own behavior in isolation;
 * this suite is deliberately invariant-shaped — it asserts the CONTRACT
 * (mutual exclusivity, lifecycle-clears) generically across the whole action
 * set, so a new selection-mutating action that forgets to clear focus (or
 * vice versa) fails here even before anyone writes a dedicated test for it.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { useBlockStore } from '../blocks'
import { useNavigationStore } from '../navigation'
import { useTabsStore } from '../tabs'

/** Mutual exclusivity: never both editing AND multi-selecting at once. */
function assertModesExclusive(): void {
  const { focusedBlockId, selectedBlockIds } = useBlockStore.getState()
  if (focusedBlockId !== null && selectedBlockIds.length > 0) {
    throw new Error(
      `Invariant violated: focusedBlockId=${focusedBlockId} AND selectedBlockIds=` +
        `${JSON.stringify(selectedBlockIds)} — editing and multi-selecting must be exclusive.`,
    )
  }
}

describe('cross-store invariants (#2465)', () => {
  beforeEach(() => {
    useBlockStore.setState({
      focusedBlockId: null,
      selectedBlockIds: [],
      selectionAnchorId: null,
      selectionFocusId: null,
    })
    useNavigationStore.setState({ currentView: 'page-editor' })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_A', title: 'Page A' }], label: 'Page A' }],
      activeTabIndex: 0,
    })
  })

  // ---------------------------------------------------------------------
  // Invariant 1: edit/select mode exclusivity — BOTH directions.
  // ---------------------------------------------------------------------
  describe('invariant: edit/select mode exclusivity', () => {
    it('starts clean: no focus and no selection', () => {
      assertModesExclusive()
      expect(useBlockStore.getState().focusedBlockId).toBeNull()
      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })

    describe('direction A: entering edit mode exits select mode', () => {
      it('setFocused(id) with an active multi-selection clears the selection', () => {
        useBlockStore.getState().selectAll(['A', 'B', 'C'])
        expect(useBlockStore.getState().selectedBlockIds).not.toEqual([])
        assertModesExclusive()

        useBlockStore.getState().setFocused('A')

        assertModesExclusive()
        expect(useBlockStore.getState().focusedBlockId).toBe('A')
        expect(useBlockStore.getState().selectedBlockIds).toEqual([])
      })
    })

    describe('direction B: entering select mode exits edit mode', () => {
      const visible = ['A', 'B', 'C', 'D']

      // Each entry drives the store into edit mode, performs one
      // selection-mutating action against a NON-EMPTY result, then asserts
      // the invariant holds and focus was actually cleared (not just
      // "the assertion happens not to fire").
      const cases: Array<{
        name: string
        run: () => void
      }> = [
        {
          name: 'toggleSelected',
          run: () => useBlockStore.getState().toggleSelected('A'),
        },
        {
          name: 'rangeSelect',
          run: () => useBlockStore.getState().rangeSelect('B', visible),
        },
        {
          name: 'selectAll',
          run: () => useBlockStore.getState().selectAll(visible),
        },
        {
          name: 'setSelected',
          run: () => useBlockStore.getState().setSelected(['A', 'B']),
        },
        {
          name: 'extendSelection (seeded from an existing selection)',
          run: () => {
            // extendSelection requires a non-empty selection to extend from
            // (documented no-op guard). Seed one directly via setState so
            // this exercises extendSelection's OWN focus-clearing behavior,
            // not setSelected's/toggleSelected's.
            useBlockStore.setState({ selectedBlockIds: ['B'] })
            useBlockStore.getState().extendSelection('down', visible)
          },
        },
      ]

      for (const { name, run } of cases) {
        it(`${name} clears an in-progress edit`, () => {
          useBlockStore.setState({ focusedBlockId: 'EDITING_BLOCK' })

          run()

          assertModesExclusive()
          expect(useBlockStore.getState().focusedBlockId).toBeNull()
          expect(useBlockStore.getState().selectedBlockIds.length).toBeGreaterThan(0)
        })
      }
    })

    it('an interleaved sequence of edit/select actions never violates exclusivity', () => {
      const visible = ['A', 'B', 'C', 'D', 'E']
      const steps: Array<() => void> = [
        () => useBlockStore.getState().setFocused('A'),
        () => useBlockStore.getState().toggleSelected('B'),
        () => useBlockStore.getState().setFocused('C'),
        () => useBlockStore.getState().rangeSelect('D', visible),
        () => useBlockStore.getState().setFocused('E'),
        () => useBlockStore.getState().selectAll(visible),
        () => useBlockStore.getState().setFocused(null),
        () => useBlockStore.getState().setSelected(['A']),
        () => useBlockStore.getState().extendSelection('down', visible),
        () => useBlockStore.getState().clearSelected(),
      ]

      for (const step of steps) {
        step()
        assertModesExclusive()
      }
    })
  })

  // ---------------------------------------------------------------------
  // Invariant 2: selection lifecycle — cleared on every documented trigger.
  // ---------------------------------------------------------------------
  describe('invariant: selection lifecycle', () => {
    it('trigger — entering edit mode (restates exclusivity as a lifecycle event)', () => {
      useBlockStore.getState().toggleSelected('A1')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A1'])

      useBlockStore.getState().setFocused('B1')

      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })

    it('trigger — page navigation within the same tab (#2438)', () => {
      useBlockStore.getState().toggleSelected('A1')
      useBlockStore.getState().toggleSelected('A2')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A1', 'A2'])

      useTabsStore.getState().navigateToPage('PAGE_B', 'Page B')

      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })

    it('trigger — view change away from the page editor (#2438)', () => {
      useBlockStore.setState({
        selectedBlockIds: ['A1', 'A2'],
        selectionAnchorId: 'A1',
        selectionFocusId: 'A2',
      })

      useNavigationStore.getState().setView('search')

      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
      expect(useBlockStore.getState().selectionAnchorId).toBeNull()
      expect(useBlockStore.getState().selectionFocusId).toBeNull()
    })

    it('trigger — popping the page stack (goBack) (#2438)', () => {
      useTabsStore.setState({
        tabs: [
          {
            id: '0',
            pageStack: [
              { pageId: 'PAGE_A', title: 'Page A' },
              { pageId: 'PAGE_B', title: 'Page B' },
            ],
            label: 'Page B',
          },
        ],
        activeTabIndex: 0,
      })
      useBlockStore.getState().toggleSelected('B1')
      expect(useBlockStore.getState().selectedBlockIds).toEqual(['B1'])

      useTabsStore.getState().goBack()

      expect(useBlockStore.getState().selectedBlockIds).toEqual([])
    })

    it('non-trigger — an unrelated navigation-store change on the SAME page keeps the selection', () => {
      // Negative case: the lifecycle rule is "page context changed", not
      // "any navigation-store write". A same-page, same-view write (e.g. the
      // one-shot scroll-to-block slot) must not clear a live selection.
      useBlockStore.getState().toggleSelected('A1')

      useNavigationStore.getState().setSelectedBlockId('A1')

      expect(useBlockStore.getState().selectedBlockIds).toEqual(['A1'])
    })
  })
})
