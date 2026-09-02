/**
 * The same-pageId block-state fan-out (#4550).
 *
 * The registry is ref-counted and tolerates several providers for one pageId,
 * but a slot shares a SLOT, not state: each provider constructs its own store,
 * so two providers for one pageId are two independent Zustand stores with two
 * independent `blocksById`. `{{embed}}` makes that arrangement ordinary rather
 * than a transient race, and without the fan-out an embed of a page open
 * elsewhere renders pre-edit content until something remounts it.
 *
 * The failure mode on the other side is worse and quieter: this registry is
 * load-bearing for the journal week/month views, which mount up to 30 sibling
 * providers. Those are DISTINCT pageIds — one slot each, `refCount === 1` —
 * so the fan-out must be provably inert for them. That is what the second
 * block below pins.
 */

import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock } from '@/__tests__/fixtures'
import { PageBlockStoreProvider, usePageBlockStoreApi } from '@/stores/page-blocks'
import type { PageBlockState } from '@/stores/page-blocks'

/** Publishes its provider's store into `sink`, in mount order. */
function Probe({ sink }: { sink: StoreApi<PageBlockState>[] }): React.ReactElement {
  const store = usePageBlockStoreApi()
  useEffect(() => {
    sink.push(store)
  }, [store, sink])
  return <span />
}

/**
 * `slots` names one provider each. Duplicated page ids are the point of this
 * file, so each entry carries its own stable key rather than being keyed by
 * the (repeated) page id.
 */
function mountProviders(slots: Array<{ key: string; pageId: string }>) {
  const sink: StoreApi<PageBlockState>[] = []
  const view = render(
    <>
      {slots.map(({ key, pageId }) => (
        <PageBlockStoreProvider key={key} pageId={pageId}>
          <Probe sink={sink} />
        </PageBlockStoreProvider>
      ))}
    </>,
  )
  return { sink, view }
}

const ROWS = [makeBlock({ id: 'B1', content: 'first', depth: 0 })]
const EDITED = [makeBlock({ id: 'B1', content: 'edited', depth: 0 })]

describe('two providers for the SAME pageId', () => {
  it('fans a block write out to the sibling store', () => {
    const { sink } = mountProviders([
      { key: 'a1', pageId: 'PAGE_A' },
      { key: 'a2', pageId: 'PAGE_A' },
    ])
    const [first, second] = sink
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)

    act(() => {
      first?.setState({ blocks: ROWS })
    })
    expect(second?.getState().blocks).toEqual(ROWS)
    // The sibling shares the SOURCE's map reference rather than an
    // equal-but-distinct rebuild, so memoized rows do not all invalidate.
    expect(second?.getState().blocksById).toBe(first?.getState().blocksById)

    // …and in the other direction: whichever provider owns the registry slot
    // is irrelevant to the fan-out.
    act(() => {
      second?.setState({ blocks: EDITED })
    })
    expect(first?.getState().blocks).toEqual(EDITED)
  })

  it('does not mirror `loading`, so an embed mounting cannot flash a skeleton over the source page', () => {
    const { sink } = mountProviders([
      { key: 'a1', pageId: 'PAGE_A' },
      { key: 'a2', pageId: 'PAGE_A' },
    ])
    const [first, second] = sink
    act(() => {
      first?.setState({ blocks: ROWS, loading: false })
    })
    act(() => {
      second?.setState({ loading: true })
    })
    expect(first?.getState().loading).toBe(false)
  })

  it('terminates: one hop, not a bounce', () => {
    const { sink } = mountProviders([
      { key: 'a1', pageId: 'PAGE_A' },
      { key: 'a2', pageId: 'PAGE_A' },
    ])
    const [first, second] = sink
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    first?.subscribe(firstListener)
    second?.subscribe(secondListener)

    act(() => {
      first?.setState({ blocks: ROWS })
    })

    // The source notifies once (its own write); the sibling once (the mirror).
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(1)
  })

  it('stops mirroring into a provider that has unmounted', () => {
    const sink: StoreApi<PageBlockState>[] = []
    function Harness({ both }: { both: boolean }): React.ReactElement {
      return (
        <>
          <PageBlockStoreProvider pageId="PAGE_A">
            <Probe sink={sink} />
          </PageBlockStoreProvider>
          {both && (
            <PageBlockStoreProvider pageId="PAGE_A">
              <Probe sink={sink} />
            </PageBlockStoreProvider>
          )}
        </>
      )
    }
    const { rerender } = render(<Harness both />)
    const [survivor, leaving] = sink
    rerender(<Harness both={false} />)

    act(() => {
      survivor?.setState({ blocks: ROWS })
    })
    // The unmounted provider's store is detached: it neither receives the
    // write nor keeps a live subscription on the slot.
    expect(leaving?.getState().blocks).toEqual([])
  })
})

describe('sibling providers for DIFFERENT pageIds (the journal week/month shape)', () => {
  it('never crosses a page boundary', () => {
    const { sink } = mountProviders([
      { key: 'd1', pageId: 'DAY_1' },
      { key: 'd2', pageId: 'DAY_2' },
      { key: 'd3', pageId: 'DAY_3' },
    ])
    expect(sink).toHaveLength(3)

    act(() => {
      sink[0]?.setState({ blocks: ROWS })
    })

    expect(sink[1]?.getState().blocks).toEqual([])
    expect(sink[2]?.getState().blocks).toEqual([])
  })

  it('adds no extra notifications to a one-provider slot', () => {
    const { sink } = mountProviders([
      { key: 'd1', pageId: 'DAY_1' },
      { key: 'd2', pageId: 'DAY_2' },
    ])
    const listener = vi.fn()
    sink[1]?.subscribe(listener)

    act(() => {
      sink[0]?.setState({ blocks: ROWS })
    })
    expect(listener).not.toHaveBeenCalled()
  })
})
