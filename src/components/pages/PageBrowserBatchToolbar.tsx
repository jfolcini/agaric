/**
 * PageBrowserBatchToolbar — batch-action toolbar for the Pages view
 * (#81 / PEND-57, CORE scope).
 *
 * Sibling component of `PageBrowser`, mirroring the Trash/History batch
 * toolbars: it renders a shared `BatchActionToolbar` with the selection
 * count plus three bulk actions when ≥1 page is selected:
 *
 *  - **Trash** — bulk soft-delete via `deleteBlocksByIds`.
 *  - **Add tag** — pick a tag from the active space, then `addTagsByIds`.
 *  - **Move to space** — pick a target space, then `moveBlocksToSpace`.
 *
 * After a successful op it clears the selection and calls `onMutated`
 * (the parent's list-refresh path); success / error surface via
 * `@/lib/notify`. The tag picker reuses `listAllTagsInSpace` (the same
 * tag source the tag-management list uses); the space picker reuses the
 * `useSpaceStore` `availableSpaces` snapshot (the same list the sidebar
 * `SpaceSwitcher` renders), filtering out the current space.
 *
 * Saved views, bulk star, and bulk set-property are intentionally out of
 * scope for this issue and are NOT implemented here.
 */

import { Tag, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BatchActionToolbar } from '@/components/common/BatchActionToolbar'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { TagCacheRow } from '@/lib/tauri'
import { addTagsByIds, deleteBlocksByIds, listAllTagsInSpace, moveBlocksToSpace } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

export interface PageBrowserBatchToolbarProps {
  /** Ids of the currently-selected pages (≥1 — parent gates render). */
  selectedIds: string[]
  /** Active space id; scopes the tag picker and is excluded from the
   * move-to-space targets. `null` pre-bootstrap (parent won't render). */
  currentSpaceId: string | null
  /** Select every visible page. */
  onSelectAll: () => void
  /** Clear the selection. */
  onClearSelection: () => void
  /** Called after a successful bulk op so the parent refreshes the list
   * (cache/materializer invalidation → query refetch). */
  onMutated: () => void
}

type ActivePicker = 'tag' | 'space' | null

export function PageBrowserBatchToolbar({
  selectedIds,
  currentSpaceId,
  onSelectAll,
  onClearSelection,
  onMutated,
}: PageBrowserBatchToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)

  const [activePicker, setActivePicker] = useState<ActivePicker>(null)
  const [tags, setTags] = useState<TagCacheRow[]>([])
  const [selectedTagId, setSelectedTagId] = useState<string>('')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  // Move-to-space targets exclude the current space (moving to where the
  // pages already live is a no-op).
  const moveTargets = availableSpaces.filter((s) => s.id !== currentSpaceId)

  // Lazily load the active space's tags the first time the tag picker is
  // opened. Re-run if the space changes while the picker is open.
  useEffect(() => {
    if (activePicker !== 'tag' || currentSpaceId == null) return
    let cancelled = false
    listAllTagsInSpace(currentSpaceId)
      .then((rows) => {
        if (!cancelled) setTags(rows)
      })
      .catch((err) => {
        logger.warn('PageBrowserBatchToolbar', 'failed to load tags', { currentSpaceId }, err)
        if (!cancelled) setTags([])
      })
    return () => {
      cancelled = true
    }
  }, [activePicker, currentSpaceId])

  const closePickers = useCallback(() => {
    setActivePicker(null)
    setSelectedTagId('')
    setSelectedSpaceId('')
  }, [])

  const handleTrash = useCallback(async () => {
    if (selectedIds.length === 0 || busy) return
    setBusy(true)
    try {
      const count = await deleteBlocksByIds(selectedIds)
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.trashed', { count }))
    } catch (err) {
      logger.error(
        'PageBrowserBatchToolbar',
        'bulk trash failed',
        { count: selectedIds.length },
        err,
      )
      notify.error(t('pageBrowser.batch.trashFailed'))
    } finally {
      setBusy(false)
    }
  }, [selectedIds, busy, onClearSelection, onMutated, t])

  const handleAddTag = useCallback(async () => {
    if (selectedIds.length === 0 || selectedTagId === '' || busy) return
    setBusy(true)
    try {
      const count = await addTagsByIds(selectedIds, selectedTagId)
      closePickers()
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.tagged', { count }))
    } catch (err) {
      logger.error(
        'PageBrowserBatchToolbar',
        'bulk add-tag failed',
        { count: selectedIds.length },
        err,
      )
      notify.error(t('pageBrowser.batch.addTagFailed'))
    } finally {
      setBusy(false)
    }
  }, [selectedIds, selectedTagId, busy, closePickers, onClearSelection, onMutated, t])

  const handleMoveToSpace = useCallback(async () => {
    if (selectedIds.length === 0 || selectedSpaceId === '' || busy) return
    setBusy(true)
    try {
      const count = await moveBlocksToSpace(selectedIds, selectedSpaceId)
      closePickers()
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.moved', { count }))
    } catch (err) {
      logger.error(
        'PageBrowserBatchToolbar',
        'bulk move failed',
        { count: selectedIds.length },
        err,
      )
      notify.error(t('pageBrowser.batch.moveFailed'))
    } finally {
      setBusy(false)
    }
  }, [selectedIds, selectedSpaceId, busy, closePickers, onClearSelection, onMutated, t])

  return (
    <BatchActionToolbar
      selectedCount={selectedIds.length}
      className="page-browser-batch-toolbar gap-3 p-3"
      suppressRangeSelectHint
    >
      <Button variant="outline" size="sm" onClick={onSelectAll} disabled={busy}>
        {t('pageBrowser.select.selectAll')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={busy}>
        {t('pageBrowser.select.clear')}
      </Button>

      <Button
        variant="destructive"
        size="sm"
        onClick={handleTrash}
        disabled={busy}
        data-testid="page-batch-trash-btn"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t('pageBrowser.batch.trash')}
      </Button>

      {/* Add-tag action: reveals the tag picker, then confirms. */}
      {activePicker === 'tag' ? (
        <span className="flex items-center gap-2" data-testid="page-batch-tag-picker">
          <Select value={selectedTagId} onValueChange={setSelectedTagId}>
            <SelectTrigger
              size="sm"
              className="min-w-40"
              aria-label={t('pageBrowser.batch.tagPlaceholder')}
            >
              <SelectValue placeholder={t('pageBrowser.batch.tagPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {tags.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  {t('pageBrowser.batch.noTags')}
                </SelectItem>
              ) : (
                tags.map((tag) => (
                  <SelectItem key={tag.tag_id} value={tag.tag_id}>
                    {tag.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            variant="default"
            size="sm"
            onClick={handleAddTag}
            disabled={busy || selectedTagId === ''}
            data-testid="page-batch-tag-confirm"
          >
            {t('pageBrowser.batch.confirmAddTag')}
          </Button>
          <Button variant="ghost" size="sm" onClick={closePickers} disabled={busy}>
            {t('pageBrowser.batch.cancel')}
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setActivePicker('tag')}
          disabled={busy}
          data-testid="page-batch-add-tag-btn"
        >
          <Tag className="h-3.5 w-3.5" />
          {t('pageBrowser.batch.addTag')}
        </Button>
      )}

      {/* Move-to-space action: reveals the space picker, then confirms. */}
      {activePicker === 'space' ? (
        <span className="flex items-center gap-2" data-testid="page-batch-space-picker">
          <Select value={selectedSpaceId} onValueChange={setSelectedSpaceId}>
            <SelectTrigger
              size="sm"
              className="min-w-40"
              aria-label={t('pageBrowser.batch.spacePlaceholder')}
            >
              <SelectValue placeholder={t('pageBrowser.batch.spacePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {moveTargets.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  {t('pageBrowser.batch.noSpaces')}
                </SelectItem>
              ) : (
                moveTargets.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            variant="default"
            size="sm"
            onClick={handleMoveToSpace}
            disabled={busy || selectedSpaceId === ''}
            data-testid="page-batch-space-confirm"
          >
            {t('pageBrowser.batch.confirmMove')}
          </Button>
          <Button variant="ghost" size="sm" onClick={closePickers} disabled={busy}>
            {t('pageBrowser.batch.cancel')}
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setActivePicker('space')}
          disabled={busy}
          data-testid="page-batch-move-btn"
        >
          {t('pageBrowser.batch.moveToSpace')}
        </Button>
      )}
    </BatchActionToolbar>
  )
}
