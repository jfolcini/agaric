/**
 * Pins the commit-ordering invariant the `#4377` latest-value-mirror refactor
 * rests on.
 *
 * Across ~34 hooks and components, the old idiom wrote a mirror during render:
 *
 *   const fooRef = useRef(foo)
 *   fooRef.current = foo          // flagged by oxlint's `react/refs`
 *
 * The replacement writes it from a dependency-array-less effect instead. Which
 * KIND of effect is not a style choice, and this file is the only place that
 * says so executably:
 *
 *   - `useLayoutEffect` runs in the commit phase, before paint, and therefore
 *     before EVERY passive effect in the tree — including passive effects of
 *     DESCENDANTS, which React flushes child-first and so ahead of the
 *     component that owns the mirror.
 *   - `useEffect` (passive) runs in that same child-first flush, so a
 *     descendant reading the mirror sees the value from the PREVIOUS commit.
 *
 * That difference is not hypothetical here: Radix's `PopperAnchor` reads
 * `virtualRef.current` from a bare `useEffect`, and it is rendered as a
 * descendant of both `SelectionBubbleMenu` and `AutocompletePopover`, which own
 * the mirror. A passive write at those two sites would have parked the popover
 * on a one-commit-stale anchor rect.
 *
 * Both variants are asserted together, so this test fails if React ever changes
 * the ordering in EITHER direction rather than only catching one regression.
 */

import { render } from '@testing-library/react'
import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { describe, expect, it } from 'vitest'

/**
 * Stand-in for Radix's `PopperAnchor`: a descendant that reads the mirror from
 * a bare passive effect on every commit.
 */
function DescendantReader({ mirror, seen }: { mirror: RefObject<number>; seen: number[] }): null {
  useEffect(() => {
    seen.push(mirror.current)
  })
  return null
}

function LayoutMirrorOwner({ value, seen }: { value: number; seen: number[] }): React.ReactElement {
  const mirror = useRef(value)
  useLayoutEffect(() => {
    mirror.current = value
  })
  return <DescendantReader mirror={mirror} seen={seen} />
}

function PassiveMirrorOwner({
  value,
  seen,
}: {
  value: number
  seen: number[]
}): React.ReactElement {
  const mirror = useRef(value)
  useEffect(() => {
    mirror.current = value
  })
  return <DescendantReader mirror={mirror} seen={seen} />
}

describe('latest-value mirror: commit ordering (#4377)', () => {
  it('a useLayoutEffect mirror is already fresh when a descendant passive effect reads it', () => {
    const seen: number[] = []
    const { rerender } = render(<LayoutMirrorOwner value={1} seen={seen} />)
    rerender(<LayoutMirrorOwner value={2} seen={seen} />)
    rerender(<LayoutMirrorOwner value={3} seen={seen} />)

    expect(seen).toEqual([1, 2, 3])
  })

  it('a useEffect mirror is one commit stale to that same descendant — why the refactor uses layout', () => {
    const seen: number[] = []
    const { rerender } = render(<PassiveMirrorOwner value={1} seen={seen} />)
    rerender(<PassiveMirrorOwner value={2} seen={seen} />)
    rerender(<PassiveMirrorOwner value={3} seen={seen} />)

    // The descendant's passive effect runs BEFORE the owner's, so every read
    // after the first lags by one commit.
    expect(seen).toEqual([1, 1, 2])
  })

  it('a useLayoutEffect mirror is fresh to a passive effect CLEANUP in the same component', () => {
    // `EditableBlock` reads `rovingEditorRef.current` from a passive cleanup
    // (`setOnUpdate(null)`). React runs ALL passive destroys before ANY passive
    // create, so a passive mirror write would not have landed yet; a layout
    // write already has.
    const seen: number[] = []

    function CleanupReader({ value, keyed }: { value: number; keyed: number }): null {
      const mirror = useRef(value)
      useLayoutEffect(() => {
        mirror.current = value
      })
      useEffect(
        () => () => {
          seen.push(mirror.current)
        },
        [keyed],
      )
      return null
    }

    const { rerender } = render(<CleanupReader value={1} keyed={1} />)
    // New value AND a changed dep, so the cleanup for the previous run fires
    // on this commit.
    rerender(<CleanupReader value={2} keyed={2} />)

    expect(seen).toEqual([2])
  })
})
