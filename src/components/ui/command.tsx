/**
 * Command — thin Tailwind-styled wrapper around `cmdk` primitives.
 *
 * The cmdk library ships a headless combobox / listbox shell: input +
 * scrollable list + keyboard model + filtering + ARIA roles
 * (combobox / listbox / option). This module exposes its components
 * with Agaric design tokens (`--accent`, `--border`, `--background`,
 * `--popover`, `--muted-foreground`) so callsites get the project look
 * without restyling each time.
 *
 * Filtering note: cmdk has built-in fuzzy scoring (`shouldFilter`
 * defaults to `true`). When the visible list is already filtered
 * upstream (debounced FTS / prefix query), pass `shouldFilter={false}`
 * on the `<Command>` root to skip the client-side rescore — the
 * visible list IS the answer.
 */

import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const Command = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>): React.ReactElement => (
  <CommandPrimitive
    data-slot="command"
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
      className,
    )}
    {...props}
  />
)
Command.displayName = 'Command'

const CommandInput = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>): React.ReactElement => (
  <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
    <CommandPrimitive.Input
      data-slot="command-input"
      className={cn(
        'flex h-10 [@media(pointer:coarse)]:h-11 w-full rounded-md bg-transparent py-3 text-sm [@media(pointer:coarse)]:text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
)
CommandInput.displayName = 'CommandInput'

const CommandList = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>): React.ReactElement => (
  <CommandPrimitive.List
    data-slot="command-list"
    className={cn('max-h-72 overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
)
CommandList.displayName = 'CommandList'

const CommandEmpty = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>): React.ReactElement => (
  <CommandPrimitive.Empty
    data-slot="command-empty"
    className={cn('py-6 text-center text-sm text-muted-foreground', className)}
    {...props}
  />
)
CommandEmpty.displayName = 'CommandEmpty'

const CommandGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>): React.ReactElement => (
  <CommandPrimitive.Group
    data-slot="command-group"
    className={cn(
      'overflow-hidden p-1 text-foreground',
      '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
      className,
    )}
    {...props}
  />
)
CommandGroup.displayName = 'CommandGroup'

const CommandSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>): React.ReactElement => (
  <CommandPrimitive.Separator
    data-slot="command-separator"
    className={cn('-mx-1 h-px bg-border', className)}
    {...props}
  />
)
CommandSeparator.displayName = 'CommandSeparator'

const CommandItem = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>): React.ReactElement => (
  <CommandPrimitive.Item
    data-slot="command-item"
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground data-[disabled='true']:pointer-events-none data-[disabled='true']:opacity-50 [@media(pointer:coarse)]:py-2.5 [@media(pointer:coarse)]:text-base",
      className,
    )}
    {...props}
  />
)
CommandItem.displayName = 'CommandItem'

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
}
