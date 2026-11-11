/**
 * ListItem — the shared row of a table-like list (Pages, Trash, History,
 * Search results, Tags, Templates, Properties, Agenda).
 *
 * Rows sit flush and are told apart by a hairline divider inset to the text
 * column (`list-row`, `src/index.css`), not by a card per row: a list reads
 * as one table, the icon / checkbox gutter stays clean, and the hover and
 * keyboard-cursor fills take the subtle chip radius. 44px on a coarse
 * pointer. `listRowVariants` carries the same chrome for rows that cannot
 * be an `<li>` (grid rows, options).
 *
 * Supports `asChild` polymorphism (Radix `Slot`) so consumers can render
 * the chrome as an `<a>` for navigable lists while keeping the default
 * `<li>` semantics.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const listRowVariants = cva(
  'list-row group flex items-center gap-3 rounded-sm px-3 transition-colors [@media(pointer:coarse)]:min-h-11',
  {
    variants: {
      density: {
        default: 'py-2.5',
        compact: 'py-1.5',
      },
      interactive: {
        true: 'hover:bg-accent/50 focus-ring-visible',
        false: '',
      },
    },
    defaultVariants: { density: 'default', interactive: true },
  },
)

type ListItemProps = React.ComponentProps<'li'> &
  VariantProps<typeof listRowVariants> & { asChild?: boolean }

const ListItem = ({
  ref,
  className,
  density,
  interactive,
  asChild = false,
  ...props
}: ListItemProps) => {
  const Comp = asChild ? Slot.Root : 'li'
  return (
    <Comp
      ref={ref}
      data-slot="list-item"
      className={cn(listRowVariants({ density, interactive }), className)}
      {...props}
    />
  )
}
ListItem.displayName = 'ListItem'

export { ListItem, listRowVariants }
