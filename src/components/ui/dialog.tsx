import { Dialog as DialogPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

import { CloseButtonIcon, closeButtonClassName } from './close-button'
import { ScrollArea } from './scroll-area'

// PERF: hoisted from inline string in render — twMerge only re-parses caller className.
// See pending/design-system-perf-review-2026-05-09.md Tier 3 item 16.
// LAYOUT: `flex flex-col + overflow-hidden` make header/footer pinned while DialogBody
// owns the scrollable region. See pending/dialog-responsiveness-primitive-2026-05-13.md.
const DIALOG_CONTENT_BASE =
  'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex flex-col w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-lg border p-6 shadow-lg duration-moderate sm:max-w-lg'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}
Dialog.displayName = 'Dialog'

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}
DialogTrigger.displayName = 'DialogTrigger'

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}
DialogPortal.displayName = 'DialogPortal'

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}
DialogClose.displayName = 'DialogClose'

const DialogOverlay = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) => {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 dark:bg-black/60',
        className,
      )}
      {...props}
    />
  )
}
DialogOverlay.displayName = 'DialogOverlay'

const DialogContent = ({
  ref,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) => {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="dialog-content"
        className={cn(DIALOG_CONTENT_BASE, className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className={closeButtonClassName}>
          <CloseButtonIcon />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}
DialogContent.displayName = 'DialogContent'

interface DialogBodyProps {
  ref?: React.Ref<HTMLDivElement>
  className?: string
  children?: React.ReactNode
  'data-testid'?: string
}

const DialogBody = ({ ref, className, children, ...rest }: DialogBodyProps) => {
  return (
    <ScrollArea
      ref={ref}
      data-slot="dialog-body"
      data-testid={rest['data-testid']}
      className={cn('flex-1 min-h-0 -mx-6', className)}
      // Radix's ScrollArea Viewport wraps children in an inner
      // `<div style="min-width:100%; display:table">`. `display:table`
      // shrink-wraps to content width instead of being capped at the
      // viewport, so wide/long body content (e.g. the bug-report form)
      // overflows to the right with no wrap and — since this is a
      // vertical-only ScrollArea — no horizontal scrollbar. Forcing that
      // wrapper to `block` (beats the non-important inline style) makes it
      // honour the viewport width so children wrap normally.
      viewportClassName="px-6 [&>div]:!block"
    >
      <div className="space-y-4 min-w-0">{children}</div>
    </ScrollArea>
  )
}
DialogBody.displayName = 'DialogBody'

const DialogHeader = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) => {
  return (
    <DialogPrimitive.Title
      ref={ref}
      data-slot="dialog-title"
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  )
}
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) => {
  return (
    <DialogPrimitive.Description
      ref={ref}
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}
DialogDescription.displayName = 'DialogDescription'

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
