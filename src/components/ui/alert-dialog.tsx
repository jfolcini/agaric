import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'
import type * as React from 'react'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { ScrollArea } from './scroll-area'

// LAYOUT: mirrors dialog.tsx `DIALOG_CONTENT_BASE`. Header/footer stay pinned;
// AlertDialogBody owns the scrollable region. Kept as a local const (rather than
// a cross-file shared util) so each primitive stays standalone — the two strings
// are intentionally kept in lockstep. See pending/dialog-responsiveness-primitive-2026-05-13.md.
const ALERT_DIALOG_CONTENT_BASE =
  'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex flex-col w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-xl border p-6 shadow-lg duration-moderate sm:max-w-lg'

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}
AlertDialog.displayName = 'AlertDialog'

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}
AlertDialogTrigger.displayName = 'AlertDialogTrigger'

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}
AlertDialogPortal.displayName = 'AlertDialogPortal'

const AlertDialogOverlay = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) => {
  return (
    <AlertDialogPrimitive.Overlay
      ref={ref}
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 dark:bg-black/60',
        className,
      )}
      {...props}
    />
  )
}
AlertDialogOverlay.displayName = 'AlertDialogOverlay'

const AlertDialogContent = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) => {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={ref}
        data-slot="alert-dialog-content"
        className={cn(ALERT_DIALOG_CONTENT_BASE, className)}
        {...props}
      />
    </AlertDialogPortal>
  )
}
AlertDialogContent.displayName = 'AlertDialogContent'

// Extends the full `<div>` prop surface (like AlertDialogHeader/Footer) so
// callers can forward `aria-*` / `role` / `data-*` onto the scroll container —
// the body is the scrollable region and a frequent target for a11y attributes.
interface AlertDialogBodyProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  children?: React.ReactNode
  ref?: React.Ref<HTMLDivElement>
}

const AlertDialogBody = ({ ref, className, children, dir, ...props }: AlertDialogBodyProps) => {
  return (
    <ScrollArea
      ref={ref}
      data-slot="alert-dialog-body"
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
}
AlertDialogBody.displayName = 'AlertDialogBody'

const AlertDialogHeader = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}
AlertDialogHeader.displayName = 'AlertDialogHeader'

const AlertDialogFooter = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="alert-dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}
AlertDialogFooter.displayName = 'AlertDialogFooter'

const AlertDialogTitle = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => {
  return (
    <AlertDialogPrimitive.Title
      ref={ref}
      data-slot="alert-dialog-title"
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  )
}
AlertDialogTitle.displayName = 'AlertDialogTitle'

const AlertDialogDescription = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => {
  return (
    <AlertDialogPrimitive.Description
      ref={ref}
      data-slot="alert-dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}
AlertDialogDescription.displayName = 'AlertDialogDescription'

const AlertDialogAction = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) => {
  return (
    <AlertDialogPrimitive.Action ref={ref} className={cn(buttonVariants(), className)} {...props} />
  )
}
AlertDialogAction.displayName = 'AlertDialogAction'

const AlertDialogCancel = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) => {
  return (
    <AlertDialogPrimitive.Cancel
      ref={ref}
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    />
  )
}
AlertDialogCancel.displayName = 'AlertDialogCancel'

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
