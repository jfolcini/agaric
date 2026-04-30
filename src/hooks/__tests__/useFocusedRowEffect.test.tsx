/**
 * Tests for useFocusedRowEffect hook.
 *
 * Validates the three responsibilities the hook centralises:
 *  - Resets focusedIndex via the supplied setter when reset deps change.
 *  - Scrolls the focused row into view (mocked scrollIntoView).
 *  - Adds focus classes to the focused row and removes them on cleanup
 *    when focusedRowId becomes null or the row unmounts.
 */

import { render } from '@testing-library/react'
import type React from 'react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusedRowEffect } from '../useFocusedRowEffect'

const FOCUS_CLASSES = ['ring-2', 'ring-ring/50', 'bg-accent/30']

interface HarnessProps {
  focusedRowId: string | null
  rowAttr?: string
  focusClasses?: readonly string[]
  setFocusedIndex: (idx: number) => void
  resetDeps: React.DependencyList
  rows?: string[]
}

function Harness({
  focusedRowId,
  rowAttr = 'data-row-id',
  focusClasses = FOCUS_CLASSES,
  setFocusedIndex,
  resetDeps,
  rows = ['A', 'B', 'C'],
}: HarnessProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  useFocusedRowEffect({
    containerRef,
    focusedRowId,
    rowAttr,
    focusClasses,
    setFocusedIndex,
    resetDeps,
  })
  return (
    <div ref={containerRef}>
      {rows.map((id) => (
        <div key={id} {...{ [rowAttr]: id }}>
          Row {id}
        </div>
      ))}
    </div>
  )
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; stub it on the prototype so
  // the hook's call doesn't throw.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useFocusedRowEffect', () => {
  it('calls setFocusedIndex(0) once on mount with the initial reset deps', () => {
    const setFocusedIndex = vi.fn()
    render(<Harness focusedRowId={null} setFocusedIndex={setFocusedIndex} resetDeps={['a', 'b']} />)
    expect(setFocusedIndex).toHaveBeenCalledTimes(1)
    expect(setFocusedIndex).toHaveBeenCalledWith(0)
  })

  it('calls setFocusedIndex(0) when reset deps change between renders', () => {
    const setFocusedIndex = vi.fn()
    const { rerender } = render(
      <Harness focusedRowId={null} setFocusedIndex={setFocusedIndex} resetDeps={['a']} />,
    )
    expect(setFocusedIndex).toHaveBeenCalledTimes(1)

    rerender(<Harness focusedRowId={null} setFocusedIndex={setFocusedIndex} resetDeps={['b']} />)
    expect(setFocusedIndex).toHaveBeenCalledTimes(2)

    // No change → no extra call.
    rerender(<Harness focusedRowId={null} setFocusedIndex={setFocusedIndex} resetDeps={['b']} />)
    expect(setFocusedIndex).toHaveBeenCalledTimes(2)
  })

  it('scrolls the focused row into view when focusedRowId is set', () => {
    const setFocusedIndex = vi.fn()
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    render(<Harness focusedRowId="B" setFocusedIndex={setFocusedIndex} resetDeps={['x']} />)
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('applies focus classes to the focused row element', () => {
    const setFocusedIndex = vi.fn()
    const { container } = render(
      <Harness focusedRowId="C" setFocusedIndex={setFocusedIndex} resetDeps={['x']} />,
    )
    const rowC = container.querySelector('[data-row-id="C"]') as HTMLElement
    for (const cls of FOCUS_CLASSES) {
      expect(rowC.classList.contains(cls)).toBe(true)
    }
  })

  it('removes focus classes from the previous row when focusedRowId changes', () => {
    const setFocusedIndex = vi.fn()
    const { container, rerender } = render(
      <Harness focusedRowId="A" setFocusedIndex={setFocusedIndex} resetDeps={['x']} />,
    )
    const rowA = container.querySelector('[data-row-id="A"]') as HTMLElement
    const rowB = container.querySelector('[data-row-id="B"]') as HTMLElement
    expect(rowA.classList.contains('ring-2')).toBe(true)

    rerender(<Harness focusedRowId="B" setFocusedIndex={setFocusedIndex} resetDeps={['x']} />)
    expect(rowA.classList.contains('ring-2')).toBe(false)
    expect(rowB.classList.contains('ring-2')).toBe(true)
  })

  it('does nothing for the scroll/class effect when focusedRowId is null', () => {
    const setFocusedIndex = vi.fn()
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    render(<Harness focusedRowId={null} setFocusedIndex={setFocusedIndex} resetDeps={['x']} />)
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('skips the focus-class loop when focusClasses is empty', () => {
    const setFocusedIndex = vi.fn()
    const { container } = render(
      <Harness
        focusedRowId="A"
        focusClasses={[]}
        setFocusedIndex={setFocusedIndex}
        resetDeps={['x']}
      />,
    )
    const rowA = container.querySelector('[data-row-id="A"]') as HTMLElement
    // No classes added beyond what JSX produced.
    expect(rowA.className).toBe('')
  })

  it('does not throw when the focused row is not present in the DOM', () => {
    const setFocusedIndex = vi.fn()
    expect(() => {
      render(
        <Harness
          focusedRowId="DOES_NOT_EXIST"
          setFocusedIndex={setFocusedIndex}
          resetDeps={['x']}
        />,
      )
    }).not.toThrow()
  })

  it('cleans up applied classes on unmount', () => {
    const setFocusedIndex = vi.fn()
    const { container, unmount } = render(
      <Harness focusedRowId="A" setFocusedIndex={setFocusedIndex} resetDeps={['x']} />,
    )
    const rowA = container.querySelector('[data-row-id="A"]') as HTMLElement
    expect(rowA.classList.contains('ring-2')).toBe(true)
    unmount()
    // Element survives the unmount in jsdom because we held a reference;
    // cleanup callback should have stripped the classes.
    expect(rowA.classList.contains('ring-2')).toBe(false)
  })
})
