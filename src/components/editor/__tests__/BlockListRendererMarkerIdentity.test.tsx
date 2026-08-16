// @vitest-environment jsdom

/**
 * #3277 finding 1 — `ListMarkerContext` identity churn.
 *
 * `listMarkerValue` (BlockListRenderer.tsx) was memoized on `visibleItems`
 * identity, which changes on every committed edit (the store reallocates
 * `state.blocks` via `.slice()`), even when NO block's list marker (style /
 * ordinal) actually changed. Context.Provider re-renders EVERY consumer when
 * its value reference changes, bypassing any `React.memo` on ancestors
 * between the provider and the consumer — so a plain content edit re-rendered
 * every mounted row's marker consumer for no reason.
 *
 * This test isolates that mechanism: a `React.memo`-wrapped component
 * (mirroring `SortableBlockWrapper`) sits between the provider and a child
 * that calls `useListMarker`. The memoized wrapper's props (a bare block id)
 * never change across the rerender under test, so — under a context value
 * that stays referentially stable — React must skip the whole subtree; the
 * marker consumer's render count must not move when `visibleItems` gets a new
 * array identity with unchanged content (no marker-affecting change).
 */

import { render } from '@testing-library/react'
import { memo } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useListMarker } from '@/components/editor/ListMarkerContext'
import type { ListStyle } from '@/lib/list-style'

const consumerRenderCounts = new Map<string, number>()

function MarkerConsumer({ blockId }: { blockId: string }): React.ReactElement {
  const marker = useListMarker(blockId)
  consumerRenderCounts.set(blockId, (consumerRenderCounts.get(blockId) ?? 0) + 1)
  // The nested `ordinal-` span is additive: for the existing 'none'/'bullet'
  // fixtures below `marker.ordinal` is `undefined` (React renders nothing),
  // so `marker-${blockId}`'s `.textContent` assertions ('none' / 'bullet')
  // are unaffected. It exists so the ordinals positive-control test below
  // can observe the ordinal text without disturbing those assertions.
  return (
    <div data-testid={`marker-${blockId}`}>
      {marker.style}
      <span data-testid={`ordinal-${blockId}`}>{marker.ordinal}</span>
    </div>
  )
}

// Mirrors SortableBlockWrapper being a plain React.memo — its props (just the
// block id here) are unaffected by the rerender under test, so a WORKING fix
// must let this bail without React ever calling MarkerConsumer again.
const MemoWrapper = memo(({ blockId }: { blockId: string }) => <MarkerConsumer blockId={blockId} />)
MemoWrapper.displayName = 'MemoWrapper'

vi.mock('@/components/common/EmptyState', () => ({
  EmptyState: () => <div data-testid="empty-state" />,
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}))

vi.mock('@/components/editor/SortableBlockWrapper', () => ({
  SortableBlockWrapper: (props: { block: { id: string } }) => (
    <MemoWrapper blockId={props.block.id} />
  ),
}))

// Positive control (below): lets a single test drive `useListStyles` through
// a REAL marker change (a block's list style actually changes) to prove the
// content-signature memo still republishes a fresh context value when it
// must. Every other test in this file calls `mockReturnValue` with a stable
// empty map, matching the real hook's own no-provider behavior (see
// useListStyles.ts: `mapsEqual` collapses two empty maps to the same
// reference), so the negative-control test above is unaffected.
vi.mock('@/hooks/useListStyles', () => ({ useListStyles: vi.fn() }))

import { BlockListRenderer } from '@/components/editor/BlockListRenderer'
import { useListStyles } from '@/hooks/useListStyles'

const mockUseListStyles = vi.mocked(useListStyles)

const noop = () => {}

function makeProps(overrides: Partial<React.ComponentProps<typeof BlockListRenderer>> = {}) {
  return {
    visibleItems: [],
    blocks: [],
    loading: false,
    rootParentId: 'PAGE_1',
    isZoomed: false,
    onExitZoom: noop,
    focusedBlockId: null,
    selectedBlockIds: [] as string[],
    projected: null,
    activeId: null,
    overId: null,
    dropAfter: false,
    viewport: {
      isOffscreen: () => false,
      createObserveRef: () => vi.fn(),
      getHeight: () => 40,
      subscribe: () => () => {},
      subscribeWindow: () => () => {},
      getWindowVersion: () => 0,
    },
    rovingEditor: {
      editor: null,
      mount: vi.fn(),
      unmount: vi.fn(() => null),
      activeBlockId: null,
    } as never,
    onContainerPointerDown: noop,
    hasChildrenSet: new Set<string>(),
    collapsedIds: new Set<string>(),
    hiddenMountCount: 0,
    onExpandMount: noop,
    ...overrides,
  }
}

describe('ListMarkerContext identity (#3277 finding 1)', () => {
  it('does not re-render a marker consumer when visibleItems gets a new array identity but no marker changed', () => {
    consumerRenderCounts.clear()
    mockUseListStyles.mockReturnValue(new Map())
    const blocks = [
      makeBlock({ id: 'BLK_A', depth: 0 }),
      makeBlock({ id: 'BLK_B', depth: 0 }),
      makeBlock({ id: 'BLK_C', depth: 0 }),
    ]

    const { rerender } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )

    expect(consumerRenderCounts.get('BLK_B')).toBe(1)

    // Simulate a committed content edit: the store reallocates `state.blocks`
    // via `.slice()`, so `visibleItems` is a BRAND NEW array reference with
    // the exact same block objects (same ids, same depths — no list-marker
    // property changed anywhere on the page).
    const newVisibleItems = [...blocks]
    rerender(<BlockListRenderer {...makeProps({ visibleItems: newVisibleItems, blocks })} />)

    // A bystander row's marker consumer must NOT re-render: nothing about its
    // marker changed, and the memoized wrapper between it and the provider
    // never got new props.
    expect(consumerRenderCounts.get('BLK_B')).toBe(1)
  })

  it('DOES re-render a marker consumer when its list style actually changes', () => {
    consumerRenderCounts.clear()
    const blocks = [
      makeBlock({ id: 'BLK_A', depth: 0 }),
      makeBlock({ id: 'BLK_B', depth: 0 }),
      makeBlock({ id: 'BLK_C', depth: 0 }),
    ]

    // First render: BLK_B has no list style ('none').
    mockUseListStyles.mockReturnValue(new Map())
    const { rerender, getByTestId } = render(
      <BlockListRenderer {...makeProps({ visibleItems: blocks, blocks })} />,
    )
    expect(consumerRenderCounts.get('BLK_B')).toBe(1)
    expect(getByTestId('marker-BLK_B').textContent).toBe('none')

    // Second render: BLK_B's list style genuinely changed to 'bullet' (a real
    // marker change), same as toggling the property in production. The memo
    // must NOT suppress this — a stale bystander marker would be a
    // correctness bug, not a perf win.
    mockUseListStyles.mockReturnValue(new Map([['BLK_B', 'bullet']]))
    const newVisibleItems = [...blocks]
    rerender(<BlockListRenderer {...makeProps({ visibleItems: newVisibleItems, blocks })} />)

    expect(consumerRenderCounts.get('BLK_B')).toBe(2)
    expect(getByTestId('marker-BLK_B').textContent).toBe('bullet')
  })

  // #3277 finding 2 (review gap) — the two tests above only ever vary
  // `listStyles` (a fresh `Map` from the mock on each render), which fails
  // the `prev.listStyles === listStyles` REFERENCE check on
  // `BlockListRenderer.tsx`'s `listMarkerValue` memo before `ordinalsEqual`
  // is ever reached — so neither test exercises the ordinals comparison
  // itself. This test holds `listStyles` to the SAME Map instance across
  // the rerender (only the ORDER of two `ordered` siblings in `visibleItems`
  // changes, which flips their computed ordinals) so the reference check
  // passes and `ordinalsEqual` is the thing that decides whether a fresh
  // context value is minted.
  it('does not render a stale ordinal when two ordered siblings are reordered (ordinalsEqual positive control)', () => {
    consumerRenderCounts.clear()
    // ONE stable Map instance, returned by reference on every render.
    const orderedStyles = new Map<string, ListStyle>([
      ['BLK_B', 'ordered'],
      ['BLK_C', 'ordered'],
    ])
    mockUseListStyles.mockReturnValue(orderedStyles)

    const blockB = makeBlock({ id: 'BLK_B', depth: 0 })
    const blockC = makeBlock({ id: 'BLK_C', depth: 0 })

    const { rerender, getByTestId } = render(
      <BlockListRenderer
        {...makeProps({ visibleItems: [blockB, blockC], blocks: [blockB, blockC] })}
      />,
    )

    expect(getByTestId('ordinal-BLK_B').textContent).toBe('1')
    expect(getByTestId('ordinal-BLK_C').textContent).toBe('2')

    // Reorder B and C. `listStyles` content AND reference are unchanged —
    // only the sibling order changed — so the computed ordinals flip
    // (B: 1→2, C: 2→1). A correct `ordinalsEqual` must detect this content
    // change and mint a fresh context value; the `return true` mutant would
    // instead reuse the stale `prev.value`, leaving BLK_B showing '1'.
    const reordered = [blockC, blockB]
    rerender(<BlockListRenderer {...makeProps({ visibleItems: reordered, blocks: reordered })} />)

    expect(getByTestId('ordinal-BLK_B').textContent).toBe('2')
    expect(getByTestId('ordinal-BLK_C').textContent).toBe('1')
  })
})
