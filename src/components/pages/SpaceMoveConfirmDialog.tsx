/**
 * SpaceMoveConfirmDialog — asks once before a cross-space move drops
 * properties (#5841 S0.6).
 *
 * Lists each property the target space does not define the way the pages'
 * space does, with how many values the move removes. Each row expands to the
 * pages and blocks holding those values (`list_property_loss_values`, one
 * page at a time). Driven by `useSpaceMove`, which supplies the losses and
 * re-asks with fresh ones when the backend refuses a stale acknowledgement.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type React from 'react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { SpaceMoveConfirmation } from '@/hooks/useSpaceMove'
import { unwrap } from '@/lib/app-error'
import type { PageResponse, PropertyLoss, PropertyLossValue } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { propertyRowDisplay } from '@/lib/query-result-columns'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

export interface SpaceMoveConfirmDialogProps {
  confirmation: SpaceMoveConfirmation | null
  onConfirm: () => Promise<void>
  onDismiss: () => void
}

export function SpaceMoveConfirmDialog({
  confirmation,
  onConfirm,
  onDismiss,
}: SpaceMoveConfirmDialogProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      titleKey="spaceMove.lossTitle"
      descriptionKey="spaceMove.lossDescription"
      confirmKey="spaceMove.lossConfirm"
      values={{ space: confirmation?.request.targetName ?? '' }}
      variant="destructive"
      onConfirm={onConfirm}
      contentTestId="space-move-loss-dialog"
    >
      {confirmation && (
        <div className="flex flex-col gap-2">
          {confirmation.changed && (
            <output className="block text-sm text-muted-foreground">
              {t('spaceMove.lossChanged')}
            </output>
          )}
          <ul aria-label={t('spaceMove.lossListLabel')} className="flex flex-col gap-1">
            {confirmation.losses.map((loss) => (
              <LossRow
                key={loss.key}
                loss={loss}
                ids={confirmation.request.ids}
                targetSpaceId={confirmation.request.targetSpaceId}
              />
            ))}
          </ul>
        </div>
      )}
    </ConfirmDialog>
  )
}

interface LossRowProps {
  loss: PropertyLoss
  ids: string[]
  targetSpaceId: string
}

/** One property and its count; expands to the blocks holding its values. */
function LossRow({ loss, ids, targetSpaceId }: LossRowProps): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  return (
    <li className="rounded-md border border-border">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-between"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="flex min-w-0 items-center gap-1">
          {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          <span className="truncate">{loss.key}</span>
        </span>
        <Badge tone="secondary">{t('spaceMove.valueCount', { count: loss.count })}</Badge>
      </Button>
      {expanded && (
        <LossValues id={listId} ids={ids} targetSpaceId={targetSpaceId} propertyKey={loss.key} />
      )}
    </li>
  )
}

interface LossValuesProps {
  id: string
  ids: string[]
  targetSpaceId: string
  propertyKey: string
}

/** The blocks holding `propertyKey`'s values, a page at a time. */
function LossValues({ id, ids, targetSpaceId, propertyKey }: LossValuesProps): React.ReactElement {
  const { t } = useTranslation()
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        queryKey: ['spaceMoveLossValues', targetSpaceId, propertyKey, ids],
        queryFn: async ({ pageParam }): Promise<PageResponse<PropertyLossValue>> => {
          try {
            const page = unwrap(
              await commands.listPropertyLossValues(
                ids,
                targetSpaceId,
                propertyKey,
                pageParam ?? null,
                PAGINATION_LIMIT,
              ),
            )
            await resolveRefValues(page.items)
            return page
          } catch (err) {
            logger.warn('SpaceMoveConfirmDialog', 'failed to load values', { propertyKey }, err)
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
        // Each open re-reads: the values are what the move would drop now.
        refetchOnMount: 'always',
        gcTime: 0,
      },
      queryClient,
    )
  const resolveTitle = useResolveStore((s) => s.resolveTitle)
  const rows = data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div id={id} className="flex flex-col gap-1 px-3 pb-2">
      {isPending ? (
        <Spinner label />
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('spaceMove.valuesFailed')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((row) => (
            <li key={row.block_id} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{holderLabel(row)}</span>
              {row.deleted && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('spaceMove.inTrash')}
                </span>
              )}
              <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
                {row.value_ref === null
                  ? (propertyRowDisplay(row) ?? '')
                  : resolveTitle(row.value_ref)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <LoadMoreButton
        hasMore={hasNextPage}
        loading={isFetchingNextPage}
        onLoadMore={() => {
          void fetchNextPage()
        }}
      />
    </div>
  )
}

/** Asks the backend for the titles of the referenced blocks the resolve store has no answer for. */
async function resolveRefValues(rows: readonly PropertyLossValue[]): Promise<void> {
  const store = useResolveStore.getState()
  const ids = new Set(
    rows.flatMap((row) =>
      row.value_ref === null || store.has(row.value_ref) ? [] : [row.value_ref],
    ),
  )
  if (ids.size === 0) return
  const spaceId = useSpaceStore.getState().currentSpaceId
  await fetchAndCacheLinks(ids, spaceId, () => useSpaceStore.getState().currentSpaceId !== spaceId)
}

/** The page's title, then the block's text when the value is on a block of it. */
function holderLabel(row: PropertyLossValue): string {
  const page = row.page_title ?? ''
  if (row.page_id === row.block_id) return page
  return `${page} › ${row.content ?? ''}`
}
