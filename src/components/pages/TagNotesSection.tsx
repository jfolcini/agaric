/**
 * TagNotesSection — the notes written on a tag, on the tag's own page (#6755).
 *
 * A tag is paired with the page titled `Tag/<tag>` of its space, by that title
 * alone. Its blocks are edited here as that page's: one `BlockTree` over the
 * paired page, with its own page store. A tag with no such page yet offers
 * "Add notes", which makes the page through the tag (`create_tag_page`, the
 * one create the `Tag/` path is not refused to); the tree then seeds and
 * focuses its first block.
 */

import { useQuery } from '@tanstack/react-query'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BlockTree } from '@/components/editor/BlockTree'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { tagPageTitle } from '@/lib/name-tokens'
import { queryClient } from '@/lib/query-client'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { requireActiveScope } from '@/lib/space-scope'
import { PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

export interface TagNotesSectionProps {
  tagId: string
  /** The tag's name, which names its page. */
  tagName: string
  onNavigateToPage?: NavigateToPageFn | undefined
}

/** The id of the page paired with the tag, `null` when it has none, `undefined` until read. */
function useTagPageId(tagId: string, tagName: string, spaceId: string | null) {
  const { t } = useTranslation()
  const queryKey = ['tagPage', spaceId, tagName]
  const { data } = useQuery(
    {
      queryKey,
      enabled: spaceId !== null,
      staleTime: 0,
      queryFn: async (): Promise<string | null> => {
        try {
          const scope = requireActiveScope(spaceId ?? '')
          return unwrap(await commands.resolvePageTitle(tagPageTitle(tagName), scope)).page_id
        } catch (err) {
          reportIpcError('TagNotesSection', 'tagNotes.loadFailed', err, t, { tagId })
          return null
        }
      },
    },
    queryClient,
  )
  return { pageId: data, queryKey }
}

function TagNotesTree({
  pageId,
  onNavigateToPage,
}: {
  pageId: string
  onNavigateToPage?: NavigateToPageFn | undefined
}): React.ReactElement {
  // As `PageEditor` does for its page: the undo stack ends with the mount.
  useEffect(
    () => () => {
      useUndoStore.getState().clearPage(pageId)
    },
    [pageId],
  )
  return (
    <PageBlockStoreProvider pageId={pageId}>
      <BlockTree parentId={pageId} autoCreateFirstBlock onNavigateToPage={onNavigateToPage} />
    </PageBlockStoreProvider>
  )
}

export function TagNotesSection({
  tagId,
  tagName,
  onNavigateToPage,
}: TagNotesSectionProps): React.ReactElement {
  const { t } = useTranslation()
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const { pageId, queryKey } = useTagPageId(tagId, tagName, spaceId)
  const [creating, setCreating] = useState(false)
  // A sync, an undo or another surface can make, move or remove the page.
  useEffect(
    () =>
      subscribeToNameChanges((change) => {
        if (change.kind === 'invalidated') {
          void queryClient.invalidateQueries({ queryKey: ['tagPage'] })
        }
      }),
    [],
  )

  const addNotes = async (): Promise<void> => {
    setCreating(true)
    try {
      const page = unwrap(await commands.createTagPage(tagId))
      queryClient.setQueryData(queryKey, page.id)
    } catch (err) {
      reportIpcErrorWithReason('TagNotesSection', 'tagNotes.createFailed', err, t, { tagId })
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="space-y-2" data-testid="tag-notes">
      <h2 className="text-sm font-semibold">{t('tagNotes.title')}</h2>
      {typeof pageId === 'string' && (
        <TagNotesTree pageId={pageId} onNavigateToPage={onNavigateToPage} />
      )}
      {pageId === null && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted-foreground">{t('tagNotes.empty')}</p>
          <Button variant="outline" size="sm" disabled={creating} onClick={() => void addNotes()}>
            {creating && <Spinner />}
            {t('tagNotes.add')}
          </Button>
        </div>
      )}
    </section>
  )
}
