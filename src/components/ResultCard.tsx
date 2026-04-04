/**
 * ResultCard — shared card button for displaying a block result.
 *
 * Used by SearchPanel and TagFilterPanel to render identical result cards
 * with optional spinner, badge, and child content (e.g. breadcrumbs).
 */

import { Loader2 } from 'lucide-react'
import type React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { BlockRow } from '../lib/tauri'

export interface ResultCardProps {
  block: BlockRow
  onClick: () => void
  disabled?: boolean
  /** Extra content below the main line (e.g., breadcrumb). */
  children?: React.ReactNode
  /** Show a loading spinner on the right side */
  showSpinner?: boolean
  /** CSS class name for the content span */
  contentClassName?: string
}

export function ResultCard({
  block,
  onClick,
  disabled,
  children,
  showSpinner,
  contentClassName,
}: ResultCardProps): React.ReactElement {
  return (
    <button
      type="button"
      className="w-full cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={onClick}
      disabled={disabled}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex-1 text-sm', contentClassName)}>{block.content || '(empty)'}</span>
        {showSpinner && <Loader2 className="h-4 w-4 animate-spin shrink-0 text-muted-foreground" />}
        {(block.block_type === 'tag' || block.block_type === 'page') && (
          <Badge variant="secondary">{block.block_type}</Badge>
        )}
      </div>
      {children}
    </button>
  )
}
