/**
 * AddFilterPopover — category-menu primitives (#1648, extracted from
 * `AddFilterPopover.tsx`). `FilterCategoryGroup` renders a labelled facet
 * group; `FilterMenuItem` renders one selectable facet row.
 */

import type React from 'react'

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
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-ring-visible"
    >
      {children}
      {description && (
        <span className="block text-xs font-normal text-muted-foreground">{description}</span>
      )}
    </button>
  )
}
