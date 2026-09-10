/**
 * Tests for `useBlockRefPeek` — the two behaviours the component suite cannot
 * reach through the rendered peek:
 *
 *  - WCAG 1.4.13 "hoverable": leaving the chip only SCHEDULES the close, so
 *    the pointer can cross the gap into the peek and use its buttons.
 *  - The chip is left exactly as it was found when the host unmounts, parked
 *    `title=` included.
 */

import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockRefPeek } from '@/hooks/useBlockRefPeek'

const REF = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CHIP_TITLE = 'Chip title'

/** Chip + the inner `.block-ref-chip-label` span the real renderers emit. */
function mountChip(): { container: HTMLElement; chip: HTMLElement; label: HTMLElement } {
  const container = document.createElement('div')
  const chip = document.createElement('span')
  chip.setAttribute('data-type', 'block-ref')
  chip.setAttribute('data-id', REF)
  chip.setAttribute('title', CHIP_TITLE)
  chip.setAttribute('aria-expanded', 'false')
  const label = document.createElement('span')
  label.className = 'block-ref-chip-label'
  chip.append(label)
  container.append(chip)
  document.body.append(container)
  return { container, chip, label }
}

describe('useBlockRefPeek', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('survives the pointer travelling from the chip into the peek', () => {
    const { container, chip } = mountChip()
    const { result } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
      vi.advanceTimersByTime(350)
    })
    expect(result.current.refId).toBe(REF)

    // Pointer leaves the chip heading for the peek: the close is scheduled,
    // and the peek's own pointerenter cancels it.
    act(() => {
      fireEvent.pointerLeave(chip, { pointerType: 'mouse' })
      vi.advanceTimersByTime(100)
      result.current.keepOpen()
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.refId).toBe(REF)

    // Leaving the peek itself closes it after the same grace.
    act(() => {
      result.current.scheduleClose()
      vi.advanceTimersByTime(250)
    })
    expect(result.current.refId).toBeNull()
  })

  // `.block-ref-chip` carries `padding: 0.15em 0.5em` around its label span,
  // so crossing from the label onto that padding fires `pointerleave` on the
  // label while the pointer is still inside the chip.
  it('stays open when the pointer only crosses onto the chip’s own padding', () => {
    const { container, chip, label } = mountChip()
    const { result } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(label, { pointerType: 'mouse' })
      vi.advanceTimersByTime(350)
    })
    expect(result.current.refId).toBe(REF)

    act(() => {
      fireEvent.pointerLeave(label, { pointerType: 'mouse', relatedTarget: chip })
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.refId).toBe(REF)
  })

  it('does not cancel a pending open when the pointer crosses inside the chip', () => {
    const { container, chip, label } = mountChip()
    const { result } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(label, { pointerType: 'mouse' })
      vi.advanceTimersByTime(200)
      fireEvent.pointerLeave(label, { pointerType: 'mouse', relatedTarget: chip })
      vi.advanceTimersByTime(200)
    })
    expect(result.current.refId).toBe(REF)
  })

  it('restores the chip when the host unmounts while a peek is open', () => {
    const { container, chip } = mountChip()
    const { result, unmount } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
      vi.advanceTimersByTime(350)
    })
    expect(result.current.refId).toBe(REF)
    expect(chip.hasAttribute('title')).toBe(false)
    expect(chip.hasAttribute('data-peek-open')).toBe(true)

    unmount()

    expect(chip.getAttribute('title')).toBe(CHIP_TITLE)
    expect(chip.hasAttribute('data-peek-open')).toBe(false)
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  it('ignores a touch pointer — coarse pointers keep the native title', () => {
    const { container, chip } = mountChip()
    const { result } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(chip, { pointerType: 'touch' })
      vi.advanceTimersByTime(5000)
    })

    expect(result.current.refId).toBeNull()
    expect(chip.getAttribute('title')).toBe(CHIP_TITLE)
  })
})
