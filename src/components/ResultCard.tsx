/**
 * ResultCard — shared card button for displaying a block result.
 *
 * Used by SearchPanel and TagFilterPanel to render identical result cards
 * with optional spinner, badge, and child content (e.g. breadcrumbs).
 *
 * Inline tokens (#[ULID] tag refs, [[ULID]] block links) are rendered as
 * resolved pills via renderRichContent() + useRichContentCallbacks().
 */

import type React from 'react'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { CardButton } from '@/components/ui/card-button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useRichContentCallbacks, useTagClickHandler } from '../hooks/useRichContentCallbacks'
import type { BlockRow } from '../lib/tauri'
import { renderRichContent } from './RichContentRenderer'

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
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus } =
    useRichContentCallbacks()
  const onTagClick = useTagClickHandler()

  const richContent = useMemo(
    () =>
      block.content
        ? renderRichContent(block.content, {
            // ResultCard is wrapped in `<button>` (CardButton); keep chips
            // inert to avoid nested-interactive. `onTagClick` is threaded so
            // the gate can be flipped later. See UX-249.
            interactive: false,
            onTagClick,
            resolveBlockTitle,
            resolveBlockStatus,
            resolveTagName,
            resolveTagStatus,
          })
        : null,
    [
      block.content,
      onTagClick,
      resolveBlockTitle,
      resolveBlockStatus,
      resolveTagName,
      resolveTagStatus,
    ],
  )

  return (
    <CardButton onClick={onClick} disabled={disabled}>
      <div className="flex items-center gap-2">
        <span className={cn('flex-1 text-sm line-clamp-2', contentClassName)}>
          {richContent ?? '(empty)'}
        </span>
        {showSpinner && <Spinner className="shrink-0 text-muted-foreground" />}
        {(block.block_type === 'tag' || block.block_type === 'page') && (
          <Badge variant="secondary">{block.block_type}</Badge>
        )}
      </div>
      {children}
    </CardButton>
  )
}
