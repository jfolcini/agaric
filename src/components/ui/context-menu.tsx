import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger

/** Styled like the block context menu's shell. */
const ContextMenuContent = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      data-slot="context-menu-content"
      className={cn(
        'bg-popover text-popover-foreground z-50 min-w-44 max-w-[calc(100vw-2rem)] rounded-md border p-1 shadow-(--shadow-floating) outline-hidden',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
)

/** Styled like the block context menu's rows. */
const ContextMenuItem = ({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item>) => (
  <ContextMenuPrimitive.Item
    data-slot="context-menu-item"
    className={cn(
      'flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-popover-foreground outline-hidden transition-colors data-highlighted:bg-accent data-highlighted:text-accent-foreground focus-ring-visible [&:focus-visible]:ring-inset touch-target',
      className,
    )}
    {...props}
  />
)

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger }
