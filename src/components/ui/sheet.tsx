'use client'

import { Dialog as SheetPrimitive } from 'radix-ui'
import type * as React from 'react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

import { CloseButtonIcon, closeButtonClassName } from './close-button'
import { ScrollArea } from './scroll-area'

// PERF: hoisted from inline string in render — twMerge only re-parses caller className.
// See pending/design-system-perf-review-2026-05-09.md Tier 3 item 16.
//
// `flex flex-col overflow-hidden p-6` is baked into the base so consumers
// can drop a `<SheetBody>` slot and get a properly height-constrained
// scrollable region without re-stating padding / overflow at every call
// site — mirrors the DialogContent shape from
// pending/dialog-responsiveness-primitive-2026-05-13.md.
const SHEET_CONTENT_BASE =
  'fixed z-50 flex flex-col overflow-hidden gap-4 bg-background p-6 shadow-(--shadow-overlay) transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-moderate data-[state=open]:animate-in data-[state=open]:duration-moderate'

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}
Sheet.displayName = 'Sheet'

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}
SheetTrigger.displayName = 'SheetTrigger'

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}
SheetClose.displayName = 'SheetClose'

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}
SheetPortal.displayName = 'SheetPortal'

const SheetOverlay = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) => {
  return (
    <SheetPrimitive.Overlay
      ref={ref}
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 dark:bg-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}
SheetOverlay.displayName = 'SheetOverlay'

/**
 * Soft-keyboard inset for bottom sheets (#760).
 *
 * On Android (edge-to-edge / targetSdk 36) the theme-level `adjustResize`
 * is largely neutered: the layout viewport does NOT shrink when the IME
 * opens, so a `bottom-0`-anchored sheet — and any input focused inside it
 * — sits underneath the keyboard. `window.visualViewport` is the only
 * signal that survives edge-to-edge; this mirrors the tracking that
 * `InPageFind` (overlay variant) and `JournalCalendarDropdown` already do.
 *
 * Returns the keyboard overlap in px (0 when the keyboard is hidden, the
 * API is unavailable — jsdom, older WebViews — or `enabled` is false, so
 * desktop and Playwright behavior is byte-identical to before). A
 * pinch-zoomed viewport (`visualViewport.scale > 1`) also reports 0 —
 * zoom shrinks `vv.height` exactly like the IME does, but lifting the
 * sheet would be wrong there (desktop trackpad/touchscreen zoom).
 */
function useSoftKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    if (!enabled) {
      setInset(0)
      return
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const update = () => {
      // Pinch zoom ALSO shrinks visualViewport.height without any
      // keyboard — on a desktop browser / touchscreen (trackpad pinch,
      // WebView2 touch zoom) a zoomed viewport would otherwise float
      // every bottom sheet up by a bogus "keyboard" inset. `scale > 1`
      // is the discriminator: the IME never changes scale, pinch zoom
      // always does. Treat a zoomed viewport as "no keyboard".
      // (`undefined > 1` is false, so WebViews lacking `scale` keep the
      // plain keyboard math.)
      if (vv.scale > 1) {
        setInset(0)
        return
      }
      // Keyboard overlap = layout-viewport bottom minus visual-viewport
      // bottom. Positive only while the IME (or another bottom inset)
      // is up; clamp to 0 so transient negative readings during
      // orientation changes never push the sheet below the viewport.
      const overlap = window.innerHeight - (vv.height + vv.offsetTop)
      setInset(overlap > 0 ? Math.round(overlap) : 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [enabled])
  return inset
}

const SheetContent = ({
  ref,
  className,
  children,
  side = 'right',
  showCloseButton = true,
  style,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left'
  showCloseButton?: boolean
}) => {
  // Bottom sheets are the IME-covered case: they anchor at `bottom-0` and
  // host focusable inputs (AddPropertyPopover, SearchSheet, ConfirmDialog
  // mobile, …). Lift the sheet above the keyboard and cap its height at
  // the remaining visual viewport so a tall sheet can't shove its header
  // off the top of the screen. Other sides keep their static anchoring.
  const keyboardInset = useSoftKeyboardInset(side === 'bottom')
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        data-slot="sheet-content"
        className={cn(
          SHEET_CONTENT_BASE,
          // Modal tier (#1010): edge-anchored sheets round only their
          // inward-facing corners with the same rounded-xl as Dialog.
          side === 'right' &&
            'inset-y-0 right-0 h-full w-3/4 rounded-l-xl border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
          side === 'left' &&
            'inset-y-0 left-0 h-full w-3/4 rounded-r-xl border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
          side === 'top' &&
            'inset-x-0 top-0 h-auto rounded-b-xl border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          side === 'bottom' &&
            'inset-x-0 bottom-0 h-auto rounded-t-xl border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          className,
        )}
        // While the soft keyboard is up, lift the bottom anchor above it
        // and cap the height at the remaining (visual) viewport. Inline
        // styles override the `bottom-0` / `max-h-*` classes only for the
        // keyboard's lifetime; when the inset returns to 0 the style prop
        // reverts and the class anchoring is back in charge (#760).
        style={
          keyboardInset > 0
            ? {
                ...style,
                bottom: keyboardInset,
                maxHeight: `calc(100% - ${keyboardInset}px)`,
              }
            : style
        }
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            className={cn(closeButtonClassName, 'data-[state=open]:bg-secondary')}
          >
            <CloseButtonIcon />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}
SheetContent.displayName = 'SheetContent'

// Header/Footer dropped their own `p-4` when SheetContent gained `p-6`
// (mirrors DialogHeader/DialogFooter, which also rely on DialogContent's
// padding frame). Avoids the double-padding regression — the title now
// sits at the same 24 px gutter as the SheetBody contents below.
const SheetHeader = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  )
}
SheetHeader.displayName = 'SheetHeader'

const SheetFooter = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2', className)}
      {...props}
    />
  )
}
SheetFooter.displayName = 'SheetFooter'

const SheetTitle = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) => {
  return (
    <SheetPrimitive.Title
      ref={ref}
      data-slot="sheet-title"
      className={cn('text-lg font-semibold leading-none tracking-tight text-foreground', className)}
      {...props}
    />
  )
}
SheetTitle.displayName = 'SheetTitle'

const SheetDescription = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) => {
  return (
    <SheetPrimitive.Description
      ref={ref}
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}
SheetDescription.displayName = 'SheetDescription'

/**
 * SheetBody — scrollable content slot for `<SheetContent>`.
 *
 * Wraps children in a `ScrollArea` constrained to `flex-1 min-h-0` so it
 * shares the SheetContent's available height (everything not consumed by
 * the header/footer) instead of overflowing past the viewport. The
 * `-mx-6` + `viewportClassName="px-6"` trick lets the scrollbar sit in
 * the SheetContent's padding gutter while keeping the inner content
 * indented by the same 24 px the header uses — so left edges align.
 *
 * Optional: pre-existing consumers that render their own ad-hoc body
 * wrappers continue to work since SheetContent's base padding/overflow
 * was added defensively. Prefer SheetBody for new code.
 */
// Extends the full `<div>` prop surface (like SheetHeader/SheetFooter) so
// callers can forward `aria-*` / `role` / `data-*` onto the scroll container —
// the body is the scrollable region and a frequent target for a11y attributes.
interface SheetBodyProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  children?: React.ReactNode
  ref?: React.Ref<HTMLDivElement>
}

const SheetBody = ({ ref, className, children, dir, ...props }: SheetBodyProps) => (
  <ScrollArea
    ref={ref}
    data-slot="sheet-body"
    // `dir` on a `<div>` is `string`; ScrollArea's Radix Root narrows it to
    // 'ltr' | 'rtl' (no `undefined` under exactOptionalPropertyTypes), so
    // forward it only when it's a valid direction.
    {...(dir === 'ltr' || dir === 'rtl' ? { dir } : {})}
    className={cn('flex-1 min-h-0 -mx-6', className)}
    viewportClassName="px-6"
    {...props}
  >
    <div className="space-y-4 min-w-0">{children}</div>
  </ScrollArea>
)
SheetBody.displayName = 'SheetBody'

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
}
