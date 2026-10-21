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
 *
 * A `[[page]]` chip peeks too, as Obsidian's page preview does in its editor:
 * only while Ctrl (Cmd) is held, because a page link is what a writer's
 * pointer rests on all day. Holding the key as the pointer arrives, or
 * pressing it with the pointer already resting there, waits out the same
 * dwell, and any other key cancels it: Ctrl+B or Ctrl+← typed with the pointer
 * over a link is a chord, not a request to preview. It has no keyboard chord,
 * so `Alt+ArrowDown` stays block-ref only.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'

/** Both the TipTap NodeView chip and the read-only chip carry this pair. */
const BLOCK_REF_SELECTOR = '[data-type="block-ref"][data-id]'
const PAGE_LINK_SELECTOR = '[data-type="block-link"][data-id]'
const CHIP_SELECTOR = `${BLOCK_REF_SELECTOR}, ${PAGE_LINK_SELECTOR}`

const HOVER_INTENT_MS = 350
/** Grace for the pointer to cross the gap from chip to peek (WCAG 1.4.13). */
const CLOSE_GRACE_MS = 250

export type PeekKind = 'block-ref' | 'page-link'

export interface BlockRefPeekState {
  /** Target of the open peek, or `null` when nothing is open. */
  refId: string | null
  kind: PeekKind
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

const INITIAL = {
  refId: null,
  kind: 'block-ref' as PeekKind,
  anchorRect: null,
  fromKeyboard: false,
}

export function useBlockRefPeek(container: HTMLElement | null): BlockRefPeekState {
  const [state, setState] = useState<{
    refId: string | null
    kind: PeekKind
    anchorRect: DOMRect | null
    fromKeyboard: boolean
  }>(INITIAL)

  const chipRef = useRef<HTMLElement | null>(null)
  /** The chip's `title=`, parked while the peek is open so the native
   *  tooltip cannot race the popover, and put back on close. */
  const parkedTitleRef = useRef<string | null>(null)
  const peekRef = useRef<HTMLDivElement | null>(null)
  /** The page-link chip under the pointer, for a Ctrl (Cmd) pressed after it arrived. */
  const hoveredPageLinkRef = useRef<HTMLElement | null>(null)
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
      // A click that navigates inside the dwell unmounts the chip before its timer fires.
      if (!chip.isConnected) return
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
      setState({
        refId,
        kind: chip.matches(PAGE_LINK_SELECTOR) ? 'page-link' : 'block-ref',
        anchorRect: chip.getBoundingClientRect(),
        fromKeyboard,
      })
    },
    [clearOpenTimer, clearCloseTimer, releaseChip],
  )

  const close = useCallback(() => {
    dismiss(false)
  }, [dismiss])

  /**
   * Dismiss, restoring focus to the chip when the peek (or the chip) is what
   * holds it. Returns whether it did.
   *
   * A dismiss key is also "exit zoom" and "blur the editor", so a peek the
   * pointer merely opened owns neither half: restoring focus would pull the
   * caret out of the block being typed in, and consuming the key would
   * swallow the editor's own.
   */
  const dismissHoldingFocus = useCallback((): boolean => {
    const chip = chipRef.current
    if (chip === null) return false
    const active = document.activeElement
    const held =
      active !== null && (chip.contains(active) || peekRef.current?.contains(active) === true)
    dismiss(held)
    return held
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
      const pointer = e as PointerEvent
      if (pointer.pointerType === 'touch') return
      const chip = (e.target as HTMLElement | null)?.closest(CHIP_SELECTOR) as HTMLElement | null
      if (!chip) return
      if (chip.matches(PAGE_LINK_SELECTOR)) {
        hoveredPageLinkRef.current = chip
        if (!pointer.ctrlKey && !pointer.metaKey) return
      }
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
      if (hoveredPageLinkRef.current === chip) hoveredPageLinkRef.current = null
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
      const hovered = hoveredPageLinkRef.current
      const modifier = e.key === 'Control' || e.key === 'Meta'
      // Ahead of `defaultPrevented`: the editor consumes the chords it binds.
      if (!modifier && hovered !== null) {
        clearOpenTimer()
        if (chipRef.current === hovered) dismiss(false)
      }
      if (e.defaultPrevented) return
      if (modifier) {
        if (e.repeat || hovered === null || chipRef.current === hovered) return
        clearOpenTimer()
        openTimerRef.current = setTimeout(() => {
          open(hovered, false)
        }, HOVER_INTENT_MS)
        return
      }
      if (e.key === 'Escape') {
        if (dismissHoldingFocus()) e.preventDefault()
        return
      }
      if (e.key !== 'ArrowDown' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const chip = (document.activeElement as HTMLElement | null)?.closest(
        BLOCK_REF_SELECTOR,
      ) as HTMLElement | null
      if (!chip || container?.contains(chip) !== true) return
      e.preventDefault()
      open(chip, true)
    },
    [container, clearOpenTimer, dismiss, dismissHoldingFocus, open],
  )

  // A click on the chip itself navigates and unmounts the subtree, so neither
  // `pointerleave` nor `focusin` would ever close the peek it left behind.
  // Heard on `window`, ahead of any capture handler between it and the chip
  // that stops the click (the Ctrl+click that opens a link in a new tab).
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
    window.addEventListener('click', handleClick, true)
    window.addEventListener('focusin', handleFocusIn)
    window.addEventListener('keydown', handleKeyDown)
    // The app's `closeOverlays` shortcut (Escape, rebindable) fires exactly
    // when a keyboard-opened peek holds focus — outside any input — and
    // `preventDefault`s the key, which `handleKeyDown` honours. The broadcast
    // is therefore the only dismiss signal that peek is sure to see (#5086);
    // it is the protocol the shortcuts sheet and the welcome modal already
    // close on. Order against the keydown listeners does not matter: whichever
    // fires second finds `chipRef` already null.
    window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, dismissHoldingFocus)

    return () => {
      container.removeEventListener('pointerenter', handlePointerEnter, true)
      container.removeEventListener('pointerleave', handlePointerLeave, true)
      window.removeEventListener('click', handleClick, true)
      window.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, dismissHoldingFocus)
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      openTimerRef.current = null
      closeTimerRef.current = null
      hoveredPageLinkRef.current = null
      releaseChip()
    }
  }, [
    container,
    handlePointerEnter,
    handlePointerLeave,
    handleClick,
    handleFocusIn,
    handleKeyDown,
    dismissHoldingFocus,
    releaseChip,
  ])

  return {
    refId: state.refId,
    kind: state.kind,
    anchorRect: state.anchorRect,
    fromKeyboard: state.fromKeyboard,
    peekRef,
    close,
    keepOpen,
    scheduleClose,
    activateChip,
  }
}
