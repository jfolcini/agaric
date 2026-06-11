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
import { useTranslation } from 'react-i18next'

import { renderRichContent } from '@/components/RichContentRenderer'
import { Badge } from '@/components/ui/badge'
import { CardButton } from '@/components/ui/card-button'
import { Spinner } from '@/components/ui/spinner'
import { useRichContentCallbacks, useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import type { BlockRow } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useResolveStore } from '@/stores/resolve'

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
  const { t } = useTranslation()
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus } =
    useRichContentCallbacks()
  const onTagClick = useTagClickHandler()

  // The resolve callbacks are stable identities backed by a mutable cache
  // ref; without subscribing to `version` the memo would render the
  // `[[ULID]]` fallback indefinitely after a space-switch preload completes.
  const resolveVersion = useResolveStore((s) => s.version)
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion is intentionally load-bearing — the callbacks read a mutable cache via refs that oxlint cannot see through, so the version is the only trigger for re-resolution when the resolve store updates.
    [
      block.content,
      onTagClick,
      resolveBlockTitle,
      resolveBlockStatus,
      resolveTagName,
      resolveTagStatus,
      resolveVersion,
    ],
  )

  return (
    <CardButton onClick={onClick} disabled={disabled}>
      <div className="flex items-center gap-2">
        <span className={cn('flex-1 text-sm line-clamp-2', contentClassName)}>
          {richContent ?? t('common.empty')}
        </span>
        {showSpinner && <Spinner className="shrink-0 text-muted-foreground" />}
        {(block.block_type === 'tag' || block.block_type === 'page') && (
          <Badge tone="secondary">{block.block_type}</Badge>
        )}
      </div>
      {children}
    </CardButton>
  )
}
