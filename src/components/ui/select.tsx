import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}
Select.displayName = 'Select'

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}
SelectGroup.displayName = 'SelectGroup'

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}
SelectValue.displayName = 'SelectValue'

const SelectTrigger = ({
  ref,
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'default' | 'sm'
}) => {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      data-slot="select-trigger"
      className={cn(
        'border-input data-[placeholder]:text-muted-foreground [&>span]:line-clamp-1 flex w-full items-center justify-between gap-2 rounded-md border bg-transparent py-2 shadow-xs whitespace-nowrap focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2',
        size === 'sm'
          ? 'h-7 px-2 text-xs [@media(pointer:coarse)]:h-11'
          : 'h-9 px-3 text-sm [@media(pointer:coarse)]:h-11',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="opacity-50 shrink-0 size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}
SelectTrigger.displayName = 'SelectTrigger'

const SelectScrollUpButton = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) => {
  return (
    <SelectPrimitive.ScrollUpButton
      ref={ref}
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}
SelectScrollUpButton.displayName = 'SelectScrollUpButton'

const SelectScrollDownButton = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) => {
  return (
    <SelectPrimitive.ScrollDownButton
      ref={ref}
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}
SelectScrollDownButton.displayName = 'SelectScrollDownButton'

const SelectContent = ({
  ref,
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) => {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground z-50 max-h-[min(var(--radix-select-content-available-height),24rem)] min-w-[8rem] overflow-hidden rounded-md border shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}
SelectContent.displayName = 'SelectContent'

const SelectItem = ({
  ref,
  className,
  children,
  endContent,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  /**
   * Optional content rendered AFTER `<SelectPrimitive.ItemText>`, OUTSIDE
   * the auto-mirror surface. Use this for trailing affordances (digit
   * hints, badges, …) that should appear in the dropdown row but must
   * NOT bleed into the selected-value label inside the trigger.
   *
   * Background: when `<SelectValue>` is rendered without children, Radix
   * Select portals the matched item's `ItemText` content into the
   * trigger's value span. Anything rendered alongside `ItemText` (i.e.
   * here, after the closing `</SelectPrimitive.ItemText>`) is excluded
   * from that mirror by design — it's the supported way to keep
   * row-level chrome out of the trigger label.
   *
   * Avoid the alternative pattern `<SelectValue>{currentItem?.name}</SelectValue>`:
   * passing children to `SelectValue` while items render inside
   * `ItemText` triggers React 19's "Cannot use a ref on a React element
   * as a container to `createRoot` or `createPortal`…" warning during
   * the brief window where `valueNodeHasChildren` flips from `false` to
   * `true` and Radix's per-item portal mirror fires into a span that
   * also has React-managed text children.
   */
  endContent?: React.ReactNode
}) => {
  return (
    <SelectPrimitive.Item
      ref={ref}
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {endContent}
    </SelectPrimitive.Item>
  )
}
SelectItem.displayName = 'SelectItem'

const SelectLabel = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) => {
  return (
    <SelectPrimitive.Label
      ref={ref}
      data-slot="select-label"
      className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)}
      {...props}
    />
  )
}
SelectLabel.displayName = 'SelectLabel'

const SelectSeparator = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) => {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}
SelectSeparator.displayName = 'SelectSeparator'

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
