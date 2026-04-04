/**
 * TrashView — shows soft-deleted blocks (p15-t23..t25).
 *
 * WHERE deleted_at IS NOT NULL. Paginated via cursor.
 * Supports restore (p15-t24) and permanent purge (p15-t25).
 */

import { RotateCcw, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { formatTimestamp } from '../lib/format'
import type { BlockRow } from '../lib/tauri'
import { listBlocks, purgeBlock, restoreBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'

export function TrashView(): React.ReactElement {
  const { t } = useTranslation()
  const queryFn = useCallback(
    (cursor?: string) =>
      listBlocks({ showDeleted: true, ...(cursor != null && { cursor }), limit: 50 }),
    [],
  )
  const {
    items: blocks,
    loading,
    hasMore,
    loadMore,
    setItems: setBlocks,
  } = usePaginatedQuery(queryFn, { onError: 'Failed to load trash' })

  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)

  const handleRestore = useCallback(
    async (block: BlockRow) => {
      if (!block.deleted_at) return
      try {
        await restoreBlock(block.id, block.deleted_at)
        setBlocks((prev) => prev.filter((b) => b.id !== block.id))
        if (block.block_type === 'page' || block.block_type === 'tag') {
          useResolveStore.getState().set(block.id, block.content ?? 'Untitled', false)
        }
        toast.success('Block restored')
      } catch {
        toast.error('Failed to restore block')
      }
    },
    [setBlocks],
  )

  const handlePurge = useCallback(
    async (blockId: string) => {
      try {
        await purgeBlock(blockId)
        setBlocks((prev) => prev.filter((b) => b.id !== blockId))
        setConfirmPurgeId(null)
        toast.success('Block permanently deleted')
      } catch {
        toast.error('Failed to purge block')
      }
    },
    [setBlocks],
  )

  return (
    <div className="trash-view space-y-4">
      {loading && blocks.length === 0 && (
        <div className="trash-view-loading space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      )}

      {!loading && blocks.length === 0 && (
        <EmptyState icon={Trash2} message={t('trash.emptyMessage')} />
      )}

      {/* biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn */}
      <div className="trash-view-list space-y-2" role="list">
        {blocks.map((block) => (
          // biome-ignore lint/a11y/useSemanticElements: div+role used for styling flexibility with shadcn
          <div
            key={block.id}
            role="listitem"
            className="trash-item flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
            data-testid="trash-item"
          >
            <div className="trash-item-content flex min-w-0 items-center gap-3">
              <Badge variant="secondary" className="trash-item-type shrink-0">
                {block.block_type}
              </Badge>
              <span className="trash-item-text text-sm truncate">
                {block.content ?? t('trash.emptyContent')}
              </span>
              <span className="trash-item-date text-xs text-muted-foreground">
                Deleted: {block.deleted_at ? formatTimestamp(block.deleted_at, 'relative') : ''}
              </span>
            </div>
            <div className="trash-item-actions flex items-center gap-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="trash-restore-btn [@media(pointer:coarse)]:h-10"
                      data-testid="trash-restore-btn"
                      onClick={() => handleRestore(block)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t('trash.restoreButton')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('trash.restoreTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Button
                variant="destructive"
                size="sm"
                className="trash-purge-btn [@media(pointer:coarse)]:h-10"
                data-testid="trash-purge-btn"
                onClick={() => setConfirmPurgeId(block.id)}
              >
                {t('trash.purgeButton')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="trash-load-more w-full"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? t('trash.loadingMessage') : t('trash.loadMoreButton')}
        </Button>
      )}

      {/* Purge confirmation dialog */}
      <AlertDialog
        open={!!confirmPurgeId}
        onOpenChange={(open) => {
          if (!open) setConfirmPurgeId(null)
        }}
      >
        <AlertDialogContent className="trash-purge-confirm" data-testid="trash-purge-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('trash.permanentlyDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('trash.permanentlyDeleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="trash-purge-no" data-testid="trash-purge-no">
              {t('trash.noButton')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="trash-purge-yes"
              data-testid="trash-purge-yes"
              onClick={() => {
                if (confirmPurgeId) handlePurge(confirmPurgeId)
              }}
            >
              {t('trash.yesDeleteButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
