/**
 * TaggedBlockChildren — the children a tagged block expands to on its tag's
 * page (#5679).
 *
 * The `{{embed}}` read path, minus the block itself (its row already shows
 * it): the owning page's store, loaded once, sliced by `selectEmbeddedRows`
 * and drawn by `EmbeddedBlockTree`, which mounts no editor.
 */

import type React from 'react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { BlockResolversProvider } from '@/components/block-tree/use-block-resolvers'
import { selectEmbeddedRows } from '@/components/editor/embed/embed-rows'
import { EmbeddedBlockTree } from '@/components/editor/embed/EmbeddedBlockTree'
import { Spinner } from '@/components/ui/spinner'
import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import { EMBED_MOUNT_LIMIT } from '@/lib/embed-token'
import {
  PageBlockStoreProvider,
  usePageBlockStore,
  usePageBlockStoreApi,
} from '@/stores/page-blocks'

export interface TaggedBlockChildrenProps {
  blockId: string
  pageId: string
}

export function TaggedBlockChildren({
  blockId,
  pageId,
}: TaggedBlockChildrenProps): React.ReactElement {
  return (
    <PageBlockStoreProvider pageId={pageId}>
      <ChildRows blockId={blockId} pageId={pageId} />
    </PageBlockStoreProvider>
  )
}

function ChildRows({ blockId, pageId }: TaggedBlockChildrenProps): React.ReactElement {
  const { t } = useTranslation()
  const store = usePageBlockStoreApi()
  const blocks = usePageBlockStore((s) => s.blocks)
  const loading = usePageBlockStore((s) => s.loading)

  useEffect(() => {
    if (store.getState().blocks.length === 0) void store.getState().load()
  }, [store])

  // One past the limit: the first row is the block itself, which is dropped.
  const { rows, hiddenCount } = useMemo(() => {
    const selection = selectEmbeddedRows(blocks, blockId, pageId, EMBED_MOUNT_LIMIT + 1)
    const children = selection.rows.slice(1)
    // Fresh copies, re-based on the block itself: shift them onto its children.
    for (const row of children) row.depth -= 1
    return { rows: children, hiddenCount: selection.hiddenCount }
  }, [blocks, blockId, pageId])

  // Outside a BlockTree nothing publishes the resolvers, so a child's tag and
  // page-link chips would show a truncated ULID.
  const groups = useMemo(
    () => [{ page_id: pageId, page_title: null, blocks: rows }],
    [pageId, rows],
  )
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName } = useBacklinkResolution(groups)
  const resolvers = useMemo(
    () => ({
      resolveBlockTitle,
      resolveBlockStatus,
      resolveTagName,
      resolveTagStatus: resolveBlockStatus,
    }),
    [resolveBlockTitle, resolveBlockStatus, resolveTagName],
  )

  if (rows.length === 0) {
    return loading ? (
      <Spinner size="sm" label className="mx-3 my-1" />
    ) : (
      <p className="px-3 py-1 text-sm text-muted-foreground">{t('taggedItems.noChildren')}</p>
    )
  }
  return (
    <BlockResolversProvider value={resolvers}>
      <EmbeddedBlockTree rows={rows} baseAriaLevel={0} />
      {hiddenCount > 0 && (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          {t('taggedItems.moreChildren', { count: hiddenCount })}
        </p>
      )}
    </BlockResolversProvider>
  )
}
