/**
 * useBlockRefPeek — activation state machine for the block-reference peek
 * (#4551).
 *
 * ONE delegated host per page container, never one listener per chip: a page
 * renders as many `((ULID))` chips as the author typed, and #4228 deleted the
 * previous per-chip Radix tooltip for exactly that cost.
 *
 * Modelled on `useLinkPreview`, with three deliberate differences:
 *
 *  - **350 ms of dwell, not 150.** The peek is a dialog, not a one-line
 *    tooltip: a pointer crossing a paragraph of chips on its way somewhere
 *    else must open nothing.
 *  - **Focus alone never opens it.** `useLinkPreview` opens on `focusin`,
 *    which is right for a tooltip and wrong for a dialog — Tab through a
 *    paragraph would pop one open on every chip. Keyboard users ask for it
 *    with `Alt+ArrowDown` (the ARIA APG binding for an element carrying
 *    `aria-haspopup`, and unclaimed by `DEFAULT_SHORTCUTS`); `Escape` closes
 *    it and puts focus back on the chip. `focusin` is the CLOSE path here:
 *    focus landing outside both chip and peek dismisses.
 *  - **The pointer may travel into it** (WCAG 1.4.13 hoverable). Leaving the
 *    chip only SCHEDULES the close; `keepOpen` cancels it. `useLinkPreview`
 *    closes immediately, which would put the peek's own buttons out of reach
 *    of a mouse.
 *
 * Coarse pointers keep the chip's native `title=`: long-press is not wired
 * (it collides with `use-block-touch-long-press.ts`).
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

/** Both the TipTap NodeView chip and the read-only chip carry this pair. */
const CHIP_SELECTOR = '[data-type="block-ref"][data-id]'

const HOVER_INTENT_MS = 350
/** Grace for the pointer to cross the gap from chip to peek (WCAG 1.4.13). */
const CLOSE_GRACE_MS = 250

export interface BlockRefPeekState {
  /** Target of the open peek, or `null` when nothing is open. */
  refId: string | null
  anchorRect: DOMRect | null
  /** True when the open came from the keyboard, so the peek must take focus. */
  fromKeyboard: boolean
  /** Attach to the peek's root — focus and pointer containment key on it. */
  peekRef: React.RefObject<HTMLDivElement | null>
  close: () => void
  /** Pointer entered the peek — cancel the pending close. */
  keepOpen: () => void
  /** Pointer left the peek — close after the same grace period. */
  scheduleClose: () => void
  /**
   * The peek's "Open" action: click the chip the peek is about. The chip
   * already owns navigation (`onNavigate` in the read-only renderer, the
   * NodeView's own click handler in the editor), so the peek borrows it
   * instead of growing a second navigation path.
   */
  activateChip: () => void
}

const INITIAL = { refId: null, anchorRect: null, fromKeyboard: false }

export function useBlockRefPeek(container: HTMLElement | null): BlockRefPeekState {
  const [state, setState] = useState<{
    refId: string | null
    anchorRect: DOMRect | null
    fromKeyboard: boolean
  }>(INITIAL)

  const chipRef = useRef<HTMLElement | null>(null)
  /** The chip's `title=`, parked while the peek is open so the native
   *  tooltip cannot race the popover, and put back on close. */
  const parkedTitleRef = useRef<string | null>(null)
  const peekRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const releaseChip = useCallback(() => {
    const chip = chipRef.current
    if (!chip) return
    // Only flipped where the render put one: the TipTap NodeView chip is a
    // role-less `<span>` inside the contenteditable, and ARIA states are
    // prohibited there.
    if (chip.hasAttribute('aria-expanded')) chip.setAttribute('aria-expanded', 'false')
    chip.removeAttribute('data-peek-title-parked')
    if (parkedTitleRef.current !== null) chip.setAttribute('title', parkedTitleRef.current)
    parkedTitleRef.current = null
    chipRef.current = null
  }, [])

  const dismiss = useCallback(
    (restoreFocus: boolean) => {
      const chip = chipRef.current
      clearOpenTimer()
      clearCloseTimer()
      releaseChip()
      setState(INITIAL)
      if (restoreFocus) chip?.focus()
    },
    [clearOpenTimer, clearCloseTimer, releaseChip],
  )

  const open = useCallback(
    (chip: HTMLElement, fromKeyboard: boolean) => {
      clearOpenTimer()
      clearCloseTimer()
      const refId = chip.getAttribute('data-id')
      if (refId === null || refId.length === 0) return
      if (chipRef.current !== chip) {
        releaseChip()
        parkedTitleRef.current = chip.getAttribute('title')
        chip.removeAttribute('title')
        // The editor NodeView re-applies `title` on every `update()`; the marker
        // tells it not to while the peek is open.
        chip.setAttribute('data-peek-title-parked', '')
        if (chip.hasAttribute('aria-expanded')) chip.setAttribute('aria-expanded', 'true')
        chipRef.current = chip
      }
      setState({ refId, anchorRect: chip.getBoundingClientRect(), fromKeyboard })
    },
    [clearOpenTimer, clearCloseTimer, releaseChip],
  )

  const close = useCallback(() => {
    dismiss(false)
  }, [dismiss])

  const keepOpen = useCallback(() => {
    clearCloseTimer()
  }, [clearCloseTimer])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      dismiss(false)
    }, CLOSE_GRACE_MS)
  }, [clearCloseTimer, dismiss])

  const activateChip = useCallback(() => {
    const chip = chipRef.current
    dismiss(false)
    chip?.click()
  }, [dismiss])

  const handlePointerEnter = useCallback(
    (e: Event) => {
      // Coarse pointers stay on the chip's `title=` for now — see the module
      // docblock.
      if ((e as PointerEvent).pointerType === 'touch') return
      const chip = (e.target as HTMLElement | null)?.closest(CHIP_SELECTOR) as HTMLElement | null
      if (!chip) return
      clearCloseTimer()
      if (chipRef.current === chip) return
      clearOpenTimer()
      openTimerRef.current = setTimeout(() => {
        open(chip, false)
      }, HOVER_INTENT_MS)
    },
    [clearCloseTimer, clearOpenTimer, open],
  )

  const handlePointerLeave = useCallback(
    (e: Event) => {
      const chip = (e.target as HTMLElement | null)?.closest(CHIP_SELECTOR) as HTMLElement | null
      if (!chip) return
      // `pointerleave` fires on the inner `.block-ref-chip-label` span too —
      // including when the pointer only crosses onto the chip's own padding,
      // where `relatedTarget` is the chip. The pointer has not left the chip,
      // so neither the pending open nor the open peek may be cancelled.
      const to = (e as PointerEvent).relatedTarget as Node | null
      if (to !== null && chip.contains(to)) return
      clearOpenTimer()
      // Any open peek, not only the one this chip owns: skimming from chip A onto
      // B and off before B's dwell would otherwise leave A's peek open with no
      // timer pending and nothing to close it but Escape.
      if (chipRef.current !== null) scheduleClose()
    },
    [clearOpenTimer, scheduleClose],
  )

  const handleFocusIn = useCallback(
    (e: Event) => {
      if (chipRef.current === null) return
      const landed = e.target as Node | null
      if (landed === null) return
      if (chipRef.current.contains(landed)) return
      if (peekRef.current?.contains(landed) === true) return
      dismiss(false)
    },
    [dismiss],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        const chip = chipRef.current
        if (chip === null) return
        // Only a peek that HOLDS focus owns the key. Escape is also "exit
        // zoom" and "blur the editor": consuming it for a peek the pointer
        // merely opened would swallow the editor's own Escape, and restoring
        // focus would pull the caret out of the block being typed in.
        const active = document.activeElement
        const held =
          active !== null && (chip.contains(active) || peekRef.current?.contains(active) === true)
        if (held) e.preventDefault()
        dismiss(held)
        return
      }
      if (e.key !== 'ArrowDown' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const chip = (document.activeElement as HTMLElement | null)?.closest(
        CHIP_SELECTOR,
      ) as HTMLElement | null
      if (!chip || container?.contains(chip) !== true) return
      e.preventDefault()
      open(chip, true)
    },
    [container, dismiss, open],
  )

  // A click on the chip itself navigates and unmounts the subtree, so neither
  // `pointerleave` nor `focusin` would ever close the peek it left behind.
  const handleClick = useCallback(
    (event: MouseEvent) => {
      const chip = chipRef.current
      if (chip === null || !(event.target instanceof Node) || !chip.contains(event.target)) return
      dismiss(false)
    },
    [dismiss],
  )

  useEffect(() => {
    if (!container) return

    // Capture phase: `pointerenter` / `pointerleave` do not bubble, and the
    // chip's inner `.block-ref-chip-label` span is what the pointer actually
    // enters.
    container.addEventListener('pointerenter', handlePointerEnter, true)
    container.addEventListener('pointerleave', handlePointerLeave, true)
    container.addEventListener('click', handleClick, true)
    window.addEventListener('focusin', handleFocusIn)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('pointerenter', handlePointerEnter, true)
      container.removeEventListener('pointerleave', handlePointerLeave, true)
      container.removeEventListener('click', handleClick, true)
      window.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('keydown', handleKeyDown)
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      openTimerRef.current = null
      closeTimerRef.current = null
      releaseChip()
    }
  }, [
    container,
    handlePointerEnter,
    handlePointerLeave,
    handleClick,
    handleFocusIn,
    handleKeyDown,
    releaseChip,
  ])

  return {
    refId: state.refId,
    anchorRect: state.anchorRect,
    fromKeyboard: state.fromKeyboard,
    peekRef,
    close,
    keepOpen,
    scheduleClose,
    activateChip,
  }
}
