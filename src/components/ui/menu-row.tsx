import { cva } from 'class-variance-authority'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type * as React from 'react'

/**
 * The one menu row: the page ⋮ menu, the popover menus (`PopoverMenuItem`), the
 * block menu and the right-click `ContextMenuItem` all draw their rows with it.
 *
 * A pressed row fills like a hovered one, the row is 44 px tall on a coarse
 * pointer, and its icons are 16 px, 20 px on a coarse pointer, as an icon
 * button's are (`button.tsx`). The icon size sits at zero specificity, so an
 * icon that sets its own size keeps it. The ring is inset so a scrolling menu
 * does not clip it. `indent` lines a submenu's icons up under its parent's label.
 */
const menuRowVariants = cva(
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground focus-ring-visible [&:focus-visible]:ring-inset coarse:min-h-(--touch-target) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [:where(&)_svg]:size-4 coarse:[:where(&)_svg]:size-5',
  {
    variants: {
      indent: {
        0: '',
        1: 'pl-8 coarse:pl-9',
        2: 'pl-14 coarse:pl-16',
      },
      active: {
        true: 'bg-accent font-medium',
        false: '',
      },
    },
    defaultVariants: { indent: 0, active: false },
  },
)

/** The arrow at the end of a row that opens a submenu: right while closed, down once open. */
function MenuRowChevron({ expanded }: { expanded: boolean }): React.ReactElement {
  const Chevron = expanded ? ChevronDown : ChevronRight
  return <Chevron aria-hidden="true" className="ml-auto text-muted-foreground" />
}

export { MenuRowChevron, menuRowVariants }
