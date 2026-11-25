'use client'

import { Dialog as SheetPrimitive } from 'radix-ui'
import type * as React from 'react'
import { createContext, use } from 'react'

import { CloseButtonIcon, closeButtonClassName } from '@/components/ui/close-button'
import { DIALOG_BODY_VIEWPORT_CLASS, OVERLAY_SCRIM_CLASS } from '@/components/ui/dialog-shared'
import { ScrollArea } from '@/components/ui/scroll-area'
import { usePullToDismiss } from '@/hooks/usePullToDismiss'
import { cn } from '@/lib/utils'

// PERF: hoisted from an inline string in render — twMerge then only re-parses
// the caller's `className` rather than this whole base on every render.
//
// `flex flex-col overflow-hidden` and the padding are baked into the base so
// consumers can drop a `<SheetBody>` slot and get a properly height-constrained
// scrollable region without re-stating padding / overflow at every call
// site — mirrors the DialogContent shape in `./dialog-shared.ts`. Below `md`
// the padding is the app's 16 px phone gutter (`App.tsx`), so a sheet's text
// starts where the view's does; `md` is also where `useIsMobile` stops picking
// sheets over dialogs. A consumer overriding it overrides `md:` too.
//
// A closed sheet takes no taps: until it unmounts it can still sit where it
// was open (a busy main thread starts its exit late, and it springs back once
// the exit ends), and a row there took the tap meant for the view below (#6347).
const SHEET_CONTENT_BASE =
  'fixed z-50 flex flex-col overflow-hidden gap-4 bg-popover text-popover-foreground outline-none p-4 md:p-6 shadow-(--shadow-overlay) transition ease-in-out data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:duration-moderate data-[state=open]:animate-in data-[state=open]:duration-moderate'

// How a bottom sheet's drag handle closes the sheet: the Root's own
// `onOpenChange`, so a pull closes it exactly as Escape or the scrim do.
const SheetOpenChangeContext = createContext<((open: boolean) => void) | null>(null)

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return (
    <SheetOpenChangeContext value={props.onOpenChange ?? null}>
      <SheetPrimitive.Root data-slot="sheet" {...props} />
    </SheetOpenChangeContext>
  )
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

/**
 * A bottom sheet's grab handle: the 44 px strip a downward pull closes it from.
 * Only the handle starts the pull, so a swipe in the sheet's body still
 * scrolls it. Hidden from assistive tech: Escape, the close button and Back
 * close the sheet for everyone.
 */
function SheetDragHandle(props: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      data-slot="sheet-drag-handle"
      className="mx-auto -mb-4 flex h-11 w-full max-w-32 shrink-0 cursor-grab touch-none items-center justify-center"
      {...props}
    >
      <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
    </div>
  )
}

function SheetContent({
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
}) {
  const onOpenChange = use(SheetOpenChangeContext)
  const pull = usePullToDismiss({ onDismiss: () => onOpenChange?.(false) })
  const bottom = side === 'bottom'
  // The sheet follows the finger down; on release short of the threshold the
  // base `transition` springs it back.
  const pulled = bottom && pull.dragY > 0
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
          // App.tsx) rather than slicing through the view title. With the
          // keyboard up both edges move with the layout viewport, which on
          // Android ends at the keyboard's top (`MainActivity.kt`, #6790).
          // Square: it spans the screen edge to edge (docs/UX.md). The handle
          // is its top padding.
          bottom &&
            'inset-x-0 bottom-0 h-auto max-h-[calc(100dvh-3.5rem-var(--safe-area-top))] border-t pt-0 md:pt-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          className,
        )}
        style={
          pulled
            ? {
                ...style,
                transform: `translateY(${pull.dragY}px)`,
                ...(pull.dragging ? { transition: 'none' } : {}),
              }
            : style
        }
        {...props}
      >
        {bottom && <SheetDragHandle {...(onOpenChange ? pull.handlers : {})} />}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className={cn(
              closeButtonClassName,
              // On a bottom sheet the close button shares the handle's strip.
              bottom ? 'top-3 right-4' : 'top-4 right-4 md:top-6 md:right-6',
              'data-[state=open]:bg-secondary',
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
    className={cn('flex-1 min-h-0 -mx-4 md:-mx-6 -my-1', className)}
    viewportClassName={cn(DIALOG_BODY_VIEWPORT_CLASS, 'px-4 md:px-6')}
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
