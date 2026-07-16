/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from the roving editor pattern.
 *
 * Inline tokens (block_link, tag_ref) are rendered as styled spans
 * with optional click-to-navigate (block links) and deleted decoration.
 *
 * StaticBlock is a thin dispatcher over three render concerns:
 *   - {@link useRichContent}         — the rich-text tree (inline chips + block nodes)
 *   - {@link StaticQueryBlock}       — `{{query …}}` blocks
 *   - {@link StaticBlockAttachments} — attachments + PDF viewer + image lightbox/props
 */

import { Paperclip } from 'lucide-react'
import type React from 'react'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticBlockAttachments } from '@/components/editor/StaticBlockAttachments'
import { StaticQueryBlock } from '@/components/editor/StaticQueryBlock'
import { useRichContent } from '@/components/editor/useRichContent'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBatchAttachments } from '@/hooks/useBatchAttachments'
import { cn } from '@/lib/utils'

export interface StaticBlockProps {
  blockId: string
  content: string
  onFocus: (blockId: string) => void
  /** Called when the user clicks a block-link chip. */
  onNavigate?: ((id: string) => void) | undefined
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Resolve a tag ULID → display name. */
  resolveTagName?: ((id: string) => string) | undefined
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
  /** Ctrl+Click / Shift+Click selection callback. */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

function StaticBlockInner({
  blockId,
  content,
  onFocus,
  onNavigate,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  isSelected,
  onSelect,
}: StaticBlockProps): React.ReactElement {
  const { t } = useTranslation()

  const richContent = useRichContent(content, {
    onNavigate,
    resolveBlockTitle,
    resolveTagName,
    resolveBlockStatus,
    resolveTagStatus,
  })

  // StaticBlock half: read from the BatchAttachmentsProvider
  // mounted at the BlockTree level so we don't fire one
  // `listAttachments` IPC per static block on every page render. Outside
  // a provider (e.g. unit tests, isolated rendering) the hook returns
  // `null` and we fall back to "no attachments" — matches the previous
  // pre-fetch state of `useBlockAttachments`.
  const batchAttachments = useBatchAttachments()
  const attachments = batchAttachments?.get(blockId) ?? []
  const attachmentsLoading = batchAttachments?.loading ?? false
  const hasAttachments = !attachmentsLoading && attachments.length > 0

  // The outer wrapper is a passive container — no role, no
  // tabIndex, no keyboard handler. Inner controls (rich-content link/tag
  // chips, attachment buttons, QueryResult chevron) keep their own focus
  // and keyboard handling. Click on a non-interactive area still focuses
  // the block via handleOuterClick / handleQueryBlockClickCapture so the
  // roving editor can mount.
  const handleOuterClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && onSelect) {
        e.preventDefault()
        onSelect(blockId, 'toggle')
      } else if (e.shiftKey && onSelect) {
        e.preventDefault()
        onSelect(blockId, 'range')
      } else {
        onFocus(blockId)
      }
    },
    [blockId, onFocus, onSelect],
  )

  // Detect {{query ...}} blocks and render QueryResult instead of the text
  if (content?.startsWith('{{query ') && content.endsWith('}}')) {
    const expression = content.slice(8, -2).trim()
    return (
      <StaticQueryBlock
        blockId={blockId}
        expression={expression}
        onFocus={onFocus}
        onNavigate={onNavigate}
        resolveBlockTitle={resolveBlockTitle}
        onSelect={onSelect}
      />
    )
  }

  return (
    <>
      {/* passive container — no role/tabIndex/aria-label/onKeyDown.
          The wrapper accepts mouse clicks (which mount the roving TipTap
          editor via onFocus) but is not in the tab order. Inner rich-content
          chips (block-link, tag-ref, external-link) and any attachment
          buttons retain their own role/tabIndex/keyboard handling. The two
          a11y suppressions below are the cost of a passive surface that
          converts pointer clicks into editor-mount via onFocus: keyboard
          users reach the same outcome by tabbing to an inner chip/button. */}
      {/* Both suppressions must sit on the single line directly above the
          <div>: oxlint-disable-next-line only affects the immediately
          following line, so stacking them on separate lines left the first
          one disabling the second comment instead of the element. Passive
          container — keyboard activation routes through inner focusable
          controls;  comment above. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        className={cn(
          'block-static w-full min-h-[1.75rem] cursor-text rounded-md px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-[2.75rem]',
          isSelected && 'block-selected',
        )}
        data-testid="block-static"
        data-block-id={blockId}
        onClick={handleOuterClick}
      >
        {richContent ?? (
          <span className="block-placeholder text-muted-foreground italic">
            {t('block.emptyPlaceholder')}
          </span>
        )}
        {!content?.trim() && !hasAttachments && !attachmentsLoading && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none float-right ml-2 opacity-0 transition-opacity group-hover:opacity-40 group-focus-within:opacity-40 [@media(pointer:coarse)]:hidden"
              >
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {t('block.attachHint')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {hasAttachments && <StaticBlockAttachments blockId={blockId} attachments={attachments} />}
    </>
  )
}

export const StaticBlock = memo(StaticBlockInner)
StaticBlock.displayName = 'StaticBlock'
