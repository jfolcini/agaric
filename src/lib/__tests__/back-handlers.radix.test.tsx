/**
 * Integration proof for the #716 overlay back-step against REAL Radix
 * primitives (no mocks): `overlayBackHandler` dispatches a *synthetic*
 * (`isTrusted: false`) Escape keydown, and the whole tier silently dies
 * if either of these assumptions ever breaks:
 *
 *  1. Radix dialog content actually renders `role="dialog"` +
 *     `data-state="open"` (the DOM probe in `OPEN_OVERLAY_SELECTOR`);
 *  2. Radix's DismissableLayer/useEscapeKeydown responds to untrusted
 *     synthetic Escape events (some libraries gate on `event.isTrusted`,
 *     which jsdom — like a real WebView dispatch — sets to `false`);
 *  3. with stacked layers, one Escape closes only the TOPMOST layer.
 *
 * Verified against @radix-ui/react-dismissable-layer 1.1.11 /
 * react-use-escape-keydown 1.1.1 (the versions bundled by `radix-ui`):
 * the keydown listener checks only `event.key === 'Escape'`. These tests
 * pin that behavior so a Radix upgrade that starts ignoring untrusted
 * events fails CI instead of shipping a dead Android back button.
 *
 * DOM queries use `querySelectorAll` (not `getByRole`) on purpose: that
 * is exactly what the production probe does, and stacked modal dialogs
 * mark each other `aria-hidden`, which hides them from the a11y tree.
 */

import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

import { overlayBackHandler } from '../back-handlers'

function TestDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogTitle>Real Radix dialog</DialogTitle>
        <DialogDescription>back-press target</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

/** Same probe shape the production handler uses (DOM, not a11y tree). */
function openDialogCount(): number {
  return document.querySelectorAll('[role="dialog"][data-state="open"]').length
}

/** Run the handler inside `act` so Radix's close state-update flushes. */
function pressBack(): boolean {
  let consumed = false
  act(() => {
    consumed = overlayBackHandler()
  })
  return consumed
}

describe('overlayBackHandler against real Radix primitives', () => {
  it('detects an open Radix dialog and closes it via synthetic (untrusted) Escape', () => {
    const onOpenChange = vi.fn()
    render(<TestDialog onOpenChange={onOpenChange} />)
    expect(openDialogCount()).toBe(1)

    expect(pressBack()).toBe(true)

    // Dismiss assumption: DismissableLayer accepted the isTrusted=false
    // Escape and requested close.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(openDialogCount()).toBe(0)
  })

  it('reaches React onKeyDown handlers inside the dialog (palette action-menu pattern)', () => {
    // CommandPalette's action menu intercepts Radix's escape via
    // `onEscapeKeyDown` + `preventDefault` and closes ITSELF through a
    // React `onKeyDown` handler on a focused element. React delegates
    // events at the portal container, so this only works when the
    // synthetic Escape is dispatched on the focused element — dispatching
    // on `document.body` would leave the press consumed with NOTHING
    // closing (dead back button). This pins the activeElement dispatch.
    const onInnerEscape = vi.fn()
    function PaletteLike() {
      const [open, setOpen] = useState(true)
      const [menuOpen, setMenuOpen] = useState(true)
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            onOpenAutoFocus={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => {
              if (menuOpen) e.preventDefault()
            }}
          >
            <DialogTitle>Palette-like</DialogTitle>
            <DialogDescription>inner menu owns Escape</DialogDescription>
            {menuOpen && (
              <div
                role="menu"
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  onInnerEscape()
                  setMenuOpen(false)
                }}
              >
                <button type="button" role="menuitem" ref={(el) => el?.focus()}>
                  action
                </button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )
    }
    render(<PaletteLike />)
    expect(openDialogCount()).toBe(1)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')

    // First press: the inner menu (not the dialog) handles Escape.
    expect(pressBack()).toBe(true)
    expect(onInnerEscape).toHaveBeenCalledTimes(1)
    expect(openDialogCount()).toBe(1)

    // Second press: the menu is gone, so Radix closes the dialog.
    expect(pressBack()).toBe(true)
    expect(openDialogCount()).toBe(0)
  })

  it('closes only the topmost layer of stacked dialogs per press', () => {
    const onOuterChange = vi.fn()
    const onInnerChange = vi.fn()
    render(
      <>
        <TestDialog onOpenChange={onOuterChange} />
        <TestDialog onOpenChange={onInnerChange} />
      </>,
    )
    expect(openDialogCount()).toBe(2)

    // First press: only the most recently layered dialog closes.
    expect(pressBack()).toBe(true)
    expect(openDialogCount()).toBe(1)
    expect(onInnerChange).toHaveBeenCalledWith(false)
    expect(onOuterChange).not.toHaveBeenCalled()

    // Second press: the remaining dialog closes.
    expect(pressBack()).toBe(true)
    expect(openDialogCount()).toBe(0)
    expect(onOuterChange).toHaveBeenCalledWith(false)

    // Third press: nothing open — handler declines (caller moves down chain).
    expect(pressBack()).toBe(false)
  })
})
