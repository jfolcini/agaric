/**
 * ListItem — the shared row of a table-like list (Pages, Trash, History,
 * Search results, Tags, Templates, Properties, Agenda).
 *
 * A list is one card (`listCardVariants`, on the list's scroll container,
 * never per row) holding flush rows told apart by full-width hairlines
 * (`list-row`, `src/index.css`), with none after the last row. A section
 * header is a header row inside the same card (`listHeaderVariants`), never
 * a heading above it. Rows are 44px on a coarse pointer. `listRowVariants`
 * carries the row chrome for rows that cannot be an `<li>` (grid rows,
 * options).
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
  'list-row group flex items-center gap-3 px-3 transition-colors [@media(pointer:coarse)]:min-h-11',
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

/**
 * The one card a list sits in. Goes on the scroll container, only while the list has rows.
 * It never clips: a row wider than the card (touch-sized actions at a narrow width) must
 * stay reachable, so the end rows round their own corners instead. While the cursor
 * (`list-cursor`) is on an end row, the corner on its bar's side goes square to meet it.
 */
const listCardVariants = cva(
  'rounded-lg border border-border bg-card [&>:first-child]:rounded-t-[inherit] [&>:last-child]:rounded-b-[inherit] [&:has(.list-cursor:first-child)]:rounded-ss-none [&:has(.list-cursor:last-child)]:rounded-es-none',
)

/** A section header as the card's own header row: muted fill, divider below. */
const listHeaderVariants = cva(
  'list-row flex items-center gap-2 bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground',
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

export { ListItem, listCardVariants, listHeaderVariants, listRowVariants }
