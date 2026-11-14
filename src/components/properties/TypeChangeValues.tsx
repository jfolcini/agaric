/**
 * The values a type change previews (#5841): the ones that don't fit the new
 * type and the converted ones, a tab each, a page at a time, each with what it
 * becomes. A ref shows its target's title.
 */

import { useInfiniteQuery } from '@tanstack/react-query'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { holderLabel } from '@/components/pages/SpaceMoveConfirmDialog'
import { useRefTitle } from '@/components/properties/useRefTitle'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { unwrap } from '@/lib/app-error'
import type {
  ListSeparator,
  PageResponse,
  PropertyTypeChangeCounts,
  PropertyTypeChangeKind,
  PropertyTypeChangeValue,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

/**
 * The type a change goes to, the options a select takes, whether the key holds a list, and
 * where each value is split into a list or each list joined into one value.
 */
export interface Target {
  valueType: string
  options: string | null
  multiple: boolean
  separator: ListSeparator | null
}

/** A preview shown: its target, its counts, and its number, which keys the value lists. */
export interface Preview {
  target: Target
  counts: PropertyTypeChangeCounts
  seq: number
}

interface TypeChangeTabsProps {
  spaceId: string
  propertyKey: string
  fromType: string
  preview: Preview
}

/** The values that don't fit and the converted ones, a tab each; a tab with none is disabled. */
export function TypeChangeTabs({
  spaceId,
  propertyKey,
  fromType,
  preview,
}: TypeChangeTabsProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { converted, unfit } = preview.counts
  const [picked, setPicked] = useState<PropertyTypeChangeKind | null>(null)
  if (converted + unfit === 0) return null
  const tab = picked ?? (unfit > 0 ? 'unfit' : 'converted')
  const values = (kind: PropertyTypeChangeKind) => (
    <TabsContent value={kind} className="pt-2">
      <TypeChangeValues
        spaceId={spaceId}
        propertyKey={propertyKey}
        fromType={fromType}
        preview={preview}
        kind={kind}
      />
    </TabsContent>
  )
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setPicked(next === 'converted' ? 'converted' : 'unfit')}
    >
      <TabsList aria-label={t('propertiesView.typeChangeValuesLabel')}>
        <TabsTrigger value="unfit" disabled={unfit === 0}>
          {t('propertiesView.typeChangeUnfitTab', { count: unfit })}
        </TabsTrigger>
        <TabsTrigger value="converted" disabled={converted === 0}>
          {t('propertiesView.typeChangeConvertedTab', { count: converted })}
        </TabsTrigger>
      </TabsList>
      {values('unfit')}
      {values('converted')}
    </Tabs>
  )
}

interface TypeChangeValuesProps extends TypeChangeTabsProps {
  kind: PropertyTypeChangeKind
}

/** The blocks holding the values of `kind`, a page at a time. */
function TypeChangeValues({
  spaceId,
  propertyKey,
  fromType,
  preview,
  kind,
}: TypeChangeValuesProps): React.ReactElement {
  const { t } = useTranslation()
  const { valueType, options, multiple, separator } = preview.target
  const refs = { value: fromType === 'ref', converted: valueType === 'ref' }
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        // The preview's number: a preview again reads the values again.
        queryKey: ['propertyTypeChangeValues', spaceId, propertyKey, kind, preview.seq],
        queryFn: async ({ pageParam }): Promise<PageResponse<PropertyTypeChangeValue>> => {
          try {
            const page = unwrap(
              await commands.listPropertyTypeChangeValues(
                spaceId,
                propertyKey,
                valueType,
                options,
                multiple,
                separator,
                kind,
                pageParam ?? null,
                PAGINATION_LIMIT,
              ),
            )
            await resolveRefs(page.items, refs)
            return page
          } catch (err) {
            logger.warn('ChangePropertyType', 'failed to load values', { propertyKey, kind }, err)
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
        // Dropped once unmounted: the preview number restarts with the
        // dialog's row, so a later preview could find a page cached here.
        gcTime: 0,
      },
      queryClient,
    )
  const rows = data?.pages.flatMap((page) => page.items) ?? []
  if (isPending) return <Spinner label />
  if (isError) {
    return (
      <p role="alert" className="text-destructive">
        {t('spaceMove.valuesFailed')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.block_id} className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{holderLabel(row)}</span>
            {row.deleted && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('spaceMove.inTrash')}
              </span>
            )}
            <ValueText row={row} refs={refs} />
          </li>
        ))}
      </ul>
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

/** A row's value, and what it becomes; a ref shows its target's title as the cache holds it now. */
function ValueText({
  row,
  refs,
}: {
  row: PropertyTypeChangeValue
  refs: { value: boolean; converted: boolean }
}): React.ReactElement {
  const valueTitle = useRefTitle(refs.value ? row.value : null)
  const convertedTitle = useRefTitle(refs.converted ? row.converted : null)
  const value = valueTitle ?? row.value
  return (
    <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
      {row.converted === null ? value : `${value} → ${convertedTitle ?? row.converted}`}
    </span>
  )
}

/** Asks the backend for the titles of the referenced blocks the resolve store has no answer for. */
async function resolveRefs(
  rows: readonly PropertyTypeChangeValue[],
  refs: { value: boolean; converted: boolean },
): Promise<void> {
  const store = useResolveStore.getState()
  const ids = new Set(
    rows.flatMap((row) =>
      [refs.value ? row.value : null, refs.converted ? row.converted : null].filter(
        (id): id is string => id !== null && !store.has(id),
      ),
    ),
  )
  if (ids.size === 0) return
  const spaceId = useSpaceStore.getState().currentSpaceId
  await fetchAndCacheLinks(ids, spaceId, () => useSpaceStore.getState().currentSpaceId !== spaceId)
}
