'use client'

import { Dialog as SheetPrimitive } from 'radix-ui'
import type * as React from 'react'

import { CloseButtonIcon, closeButtonClassName } from '@/components/ui/close-button'
import { DIALOG_BODY_VIEWPORT_CLASS, OVERLAY_SCRIM_CLASS } from '@/components/ui/dialog-shared'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSoftKeyboardInset } from '@/hooks/useSoftKeyboardInset'
import { cn } from '@/lib/utils'

// PERF: hoisted from an inline string in render — twMerge then only re-parses
// the caller's `className` rather than this whole base on every render.
//
// `flex flex-col overflow-hidden` and the padding are baked into the base so
// consumers can drop a `<SheetBody>` slot and get a properly height-constrained
// scrollable region without re-stating padding / overflow at every call
// site — mirrors the DialogContent shape in `./dialog-shared.ts`. Below `sm`
// the padding is the app's 16 px phone gutter (`App.tsx`), so a sheet's text
// starts where the view's does. A consumer overriding it overrides `sm:` too.
const SHEET_CONTENT_BASE =
  'fixed z-50 flex flex-col overflow-hidden gap-4 bg-popover text-popover-foreground outline-none p-4 sm:p-6 shadow-(--shadow-overlay) transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-moderate data-[state=open]:animate-in data-[state=open]:duration-moderate'

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
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) => (
  <SheetPrimitive.Overlay
    ref={ref}
    data-slot="sheet-overlay"
    className={cn(OVERLAY_SCRIM_CLASS, className)}
    {...props}
  />
)

SheetOverlay.displayName = 'SheetOverlay'

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
          side === 'right' &&
            'inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
          side === 'left' &&
            'inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
          side === 'top' &&
            'inset-x-0 top-0 h-auto max-h-[calc(100dvh-2rem)] border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          // A tall bottom sheet stops at the phone header's edge (`min-h-14` in
          // App.tsx) rather than slicing through the view title.
          side === 'bottom' &&
            'inset-x-0 bottom-0 h-auto max-h-[calc(100dvh-3.5rem-var(--safe-area-top))] border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
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
            data-slot="sheet-close"
            className={cn(
              closeButtonClassName,
              'top-4 right-4 sm:top-6 sm:right-6 data-[state=open]:bg-secondary',
            )}
          >
            <CloseButtonIcon />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}
SheetContent.displayName = 'SheetContent'

// Header/Footer carry no padding of their own (mirrors DialogHeader/
// DialogFooter, which also rely on DialogContent's padding frame), so the
// title sits on the same gutter as the SheetBody contents below.
const SheetHeader = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="sheet-header"
    className={cn('flex flex-col gap-2', className)}
    {...props}
  />
)

SheetHeader.displayName = 'SheetHeader'

const SheetFooter = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="sheet-footer"
    className={cn('mt-auto flex flex-col gap-2', className)}
    {...props}
  />
)

SheetFooter.displayName = 'SheetFooter'

const SheetTitle = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) => (
  <SheetPrimitive.Title
    ref={ref}
    data-slot="sheet-title"
    className={cn('text-lg font-semibold leading-none tracking-tight text-foreground', className)}
    {...props}
  />
)

SheetTitle.displayName = 'SheetTitle'

const SheetDescription = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) => (
  <SheetPrimitive.Description
    ref={ref}
    data-slot="sheet-description"
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
)

SheetDescription.displayName = 'SheetDescription'

/**
 * SheetBody — scrollable content slot for `<SheetContent>`.
 *
 * Wraps children in a `ScrollArea` constrained to `flex-1 min-h-0` so it
 * shares the SheetContent's available height (everything not consumed by
 * the header/footer) instead of overflowing past the viewport. The
 * negative margin + the viewport's matching padding lets the scrollbar sit in
 * the SheetContent's padding gutter while keeping the inner content
 * indented by the same gutter the header uses — so left edges align.
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
    className={cn('flex-1 min-h-0 -mx-4 sm:-mx-6 -my-1', className)}
    viewportClassName={cn(DIALOG_BODY_VIEWPORT_CLASS, 'px-4 sm:px-6')}
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
