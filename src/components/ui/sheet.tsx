'use client'

import { Dialog as SheetPrimitive } from 'radix-ui'
import type * as React from 'react'

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
  'fixed z-50 flex flex-col overflow-hidden gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-moderate data-[state=open]:animate-in data-[state=open]:duration-moderate'

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

const SheetContent = ({
  ref,
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left'
  showCloseButton?: boolean
}) => {
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
            'inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          side === 'bottom' &&
            'inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          className,
        )}
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
interface SheetBodyProps {
  ref?: React.Ref<HTMLDivElement>
  className?: string
  children?: React.ReactNode
}

const SheetBody = ({ ref, className, children }: SheetBodyProps) => (
  <ScrollArea ref={ref} className={cn('flex-1 min-h-0 -mx-6', className)} viewportClassName="px-6">
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
