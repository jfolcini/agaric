/**
 * AddFilterPopover — category-menu primitives (#1648, extracted from
 * `AddFilterPopover.tsx`). `FilterCategoryGroup` renders a labelled facet
 * group; `FilterMenuItem` renders one selectable facet row.
 */

import type React from 'react'

import { menuRowVariants } from '@/components/ui/menu-row'

export function FilterCategoryGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function FilterMenuItem({
  onClick,
  children,
  description,
}: {
  onClick: () => void
  children: React.ReactNode
  /** Optional muted helper text rendered under the label (facet disambiguation). */
  description?: string
}): React.ReactElement {
  return (
    <button type="button" onClick={onClick} className={menuRowVariants()}>
      {/* One flex item, so the description stacks under the label. */}
      <span>
        {children}
        {description && (
          <span className="block text-xs font-normal text-muted-foreground">{description}</span>
        )}
      </span>
    </button>
  )
}
