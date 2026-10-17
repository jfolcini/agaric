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

import { selectEmbeddedRows } from '@/components/editor/embed/embed-rows'
import { EmbeddedBlockTree } from '@/components/editor/embed/EmbeddedBlockTree'
import { Spinner } from '@/components/ui/spinner'
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
  const rows = useMemo(() => {
    const subtree = selectEmbeddedRows(blocks, blockId, pageId, EMBED_MOUNT_LIMIT + 1).rows
    const children = subtree.slice(1)
    // Fresh copies, re-based on the block itself: shift them onto its children.
    for (const row of children) row.depth -= 1
    return children
  }, [blocks, blockId, pageId])

  if (rows.length === 0) {
    return loading ? (
      <Spinner size="sm" label className="mx-3 my-1" />
    ) : (
      <p className="px-3 py-1 text-sm text-muted-foreground">{t('taggedItems.noChildren')}</p>
    )
  }
  return <EmbeddedBlockTree rows={rows} baseAriaLevel={0} />
}
