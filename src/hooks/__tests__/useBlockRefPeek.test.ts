/**
 * Tests for `useBlockRefPeek` — the two behaviours the component suite cannot
 * reach through the rendered peek:
 *
 *  - WCAG 1.4.13 "hoverable": leaving the chip only SCHEDULES the close, so
 *    the pointer can cross the gap into the peek and use its buttons.
 *  - The chip is left exactly as it was found when the host unmounts, parked
 *    `title=` included.
 *  - A `[[page]]` chip opens only with Ctrl (Cmd) held, not on a Ctrl chord,
 *    and has no keyboard chord.
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

  it('closes when the pointer skims onto a second chip and off before its dwell', () => {
    const { container, chip: chipA } = mountChip()
    const chipB = document.createElement('span')
    chipB.setAttribute('data-type', 'block-ref')
    chipB.setAttribute('data-id', '01OTHERCHIP000000000000000')
    chipB.setAttribute('aria-expanded', 'false')
    container.append(chipB)
    const { result } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(chipA, { pointerType: 'mouse' })
      vi.advanceTimersByTime(350)
    })
    expect(result.current.refId).toBe(REF)

    // A → B cancels A's close and arms B's open; off B before B's dwell must
    // still close A's peek, or it floats over the page until Escape.
    act(() => {
      fireEvent.pointerLeave(chipA, { pointerType: 'mouse' })
      fireEvent.pointerEnter(chipB, { pointerType: 'mouse' })
      vi.advanceTimersByTime(100)
      fireEvent.pointerLeave(chipB, { pointerType: 'mouse' })
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.refId).toBeNull()
    expect(chipA.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when the chip itself is clicked, since the chip navigates away', () => {
    const { container, chip, label } = mountChip()
    const { result } = renderHook(() => useBlockRefPeek(container))

    act(() => {
      fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
      vi.advanceTimersByTime(350)
    })
    expect(result.current.refId).toBe(REF)

    act(() => {
      fireEvent.click(label)
    })
    expect(result.current.refId).toBeNull()
    expect(chip.getAttribute('aria-expanded')).toBe('false')
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
    expect(chip.getAttribute('aria-expanded')).toBe('true')

    unmount()

    expect(chip.getAttribute('title')).toBe(CHIP_TITLE)
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

  describe('page-link chips', () => {
    function mountPageLink(): { container: HTMLElement; chip: HTMLElement } {
      const container = document.createElement('div')
      const chip = document.createElement('span')
      chip.setAttribute('data-type', 'block-link')
      chip.setAttribute('data-id', REF)
      chip.tabIndex = 0
      container.append(chip)
      document.body.append(container)
      return { container, chip }
    }

    it('does not open on a plain hover', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
        vi.advanceTimersByTime(5000)
      })
      expect(result.current.refId).toBeNull()
    })

    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Cmd', { metaKey: true }],
    ])('opens after the dwell when %s is held as the pointer arrives', (_, modifier) => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse', ...modifier })
        vi.advanceTimersByTime(200)
      })
      expect(result.current.refId).toBeNull()

      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(result.current.refId).toBe(REF)
      expect(result.current.kind).toBe('page-link')
    })

    it('opens after the dwell when Ctrl is pressed with the pointer already resting on it', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
        vi.advanceTimersByTime(1000)
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
        vi.advanceTimersByTime(349)
      })
      expect(result.current.refId).toBeNull()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(result.current.refId).toBe(REF)
    })

    it.each([
      ['Ctrl', 'Control', { ctrlKey: true }],
      ['Cmd', 'Meta', { metaKey: true }],
    ])('a %s tap as the pointer crosses the link opens nothing', (_, key, modifier) => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse', ...modifier })
        vi.advanceTimersByTime(200)
        fireEvent.keyUp(window, { key })
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.refId).toBeNull()
    })

    // The pointer rests on a link in the block being typed in.
    it('a key pressed with Ctrl cancels the pending preview and closes an open one', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
        fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true })
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.refId).toBeNull()

      act(() => {
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
        vi.advanceTimersByTime(350)
      })
      expect(result.current.refId).toBe(REF)

      // A chord the editor consumes (`preventDefault`) closes it too.
      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, cancelable: true })
        event.preventDefault()
        window.dispatchEvent(event)
      })
      expect(result.current.refId).toBeNull()
    })

    it('ignores Ctrl’s auto-repeat, so a preview closed with Ctrl still held stays closed', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse', ctrlKey: true })
        vi.advanceTimersByTime(350)
      })
      expect(result.current.refId).toBe(REF)

      act(() => {
        fireEvent.keyDown(window, { key: 'Escape', ctrlKey: true })
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true, repeat: true })
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.refId).toBeNull()
    })

    // The Ctrl+click that opens a link in a new tab stops the click in a
    // capture handler above the page; the tab switch keeps this host mounted.
    it('closes on a click on the chip that an ancestor stops in the capture phase', () => {
      const { container, chip } = mountPageLink()
      const wrapper = document.createElement('div')
      container.replaceWith(wrapper)
      wrapper.append(container)
      wrapper.addEventListener('click', (e) => e.stopPropagation(), true)
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse', ctrlKey: true })
        vi.advanceTimersByTime(350)
      })
      expect(result.current.refId).toBe(REF)

      act(() => {
        fireEvent.click(chip, { ctrlKey: true })
      })
      expect(result.current.refId).toBeNull()
    })

    it('ignores Ctrl once the pointer has left the chip', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
        fireEvent.pointerLeave(chip, { pointerType: 'mouse' })
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.refId).toBeNull()
    })

    // Clicking a static block swaps its chips for the editor's without a
    // `pointerleave`; a later Ctrl+B must not anchor a peek on the dead chip.
    it('ignores Ctrl once the hovered chip has left the DOM', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      act(() => {
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
        chip.remove()
        fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.refId).toBeNull()
    })

    it('has no Alt+ArrowDown chord', () => {
      const { container, chip } = mountPageLink()
      const { result } = renderHook(() => useBlockRefPeek(container))

      chip.focus()
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
      })
      expect(result.current.refId).toBeNull()
    })
  })
})
