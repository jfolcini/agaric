/**
 * PageBrowserBatchToolbar — batch-action toolbar for the Pages view
 * (#81 / CORE scope; #2003 items 2 + 3).
 *
 * Sibling component of `PageBrowser`, mirroring the Trash/History batch
 * toolbars: it renders a shared `BatchActionToolbar` with the selection
 * count plus bulk actions when ≥1 page is selected:
 *
 *  - **Trash** — bulk soft-delete via `deleteBlocksByIds`.
 *  - **Star / Unstar** — toggle the whole selection's starred state (a pure
 *    localStorage feature via `useStarredPages().setMany`; no backend call).
 *    Mixed selections (some starred, some not) are treated as "not fully
 *    starred": the control shows Star (not Unstar) and stars the whole
 *    selection — the least-surprising reading of a toggle, and idempotent
 *    for the pages already starred.
 *  - **Add tag** — pick a tag from the active space, then `addTagsByIds`.
 *  - **Move to space** — pick a target space, then `moveBlocksToSpace`.
 *  - **Set property** — pick one of `todo_state` / `priority` / `due_date` /
 *    `scheduled_date`, then a value (or Clear), and confirm via
 *    `setPropertyBatch`.
 *
 * After a successful op it clears the selection and calls `onMutated`
 * (the parent's list-refresh path); success / error surface via
 * `@/lib/notify`. The tag picker reuses `listAllTagsInSpace` (the same
 * tag source the tag-management list uses); the space picker reuses the
 * `useSpaceStore` `availableSpaces` snapshot (the same list the sidebar
 * `SpaceSwitcher` renders), filtering out the current space.
 *
 * Saved views (#2003 item 1) are a separate piece — persisted
 * `{sort, density, filters}` view snapshots — implemented in
 * `src/lib/saved-pages-views.ts` / `SavedViewsDropdown` / `SaveViewDialog`,
 * not in this toolbar.
 */

import { SlidersHorizontal, Star, StarOff, Tag, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BatchActionToolbar } from '@/components/common/BatchActionToolbar'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useStarredPages } from '@/hooks/useStarredPages'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { TagCacheRow } from '@/lib/tauri'
import {
  addTagsByIds,
  deleteBlocksByIds,
  listAllTagsInSpace,
  moveBlocksToSpace,
  setPropertyBatch,
} from '@/lib/tauri'
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

type ActivePicker = 'tag' | 'space' | 'property' | null

// The reserved, backend-allowlisted property keys settable in batch. The two
// date keys route to a native date input; the rest use a value `Select`.
const PROPERTY_KEYS = ['todo_state', 'priority', 'due_date', 'scheduled_date'] as const
type PropertyKey = (typeof PROPERTY_KEYS)[number]
const DATE_KEYS: ReadonlySet<PropertyKey> = new Set(['due_date', 'scheduled_date'])

// Sentinel Select value that maps to `null` (clear the property).
const CLEAR_VALUE = '__clear__'

export function PageBrowserBatchToolbar({
  selectedIds,
  currentSpaceId,
  onSelectAll,
  onClearSelection,
  onMutated,
}: PageBrowserBatchToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const { starredIds, setMany } = useStarredPages()

  const [activePicker, setActivePicker] = useState<ActivePicker>(null)
  const [tags, setTags] = useState<TagCacheRow[]>([])
  const [selectedTagId, setSelectedTagId] = useState<string>('')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('')
  const [propertyKey, setPropertyKey] = useState<string>('')
  // For todo_state/priority this holds the reserved value (or CLEAR_VALUE);
  // for the two date keys the native date input drives it (ISO YYYY-MM-DD).
  const [propertyValue, setPropertyValue] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false)

  // Human labels for the property keys and their reserved value options.
  const propertyLabels: Record<PropertyKey, string> = {
    todo_state: t('pageBrowser.batch.propTodoState'),
    priority: t('pageBrowser.batch.propPriority'),
    due_date: t('pageBrowser.batch.propDueDate'),
    scheduled_date: t('pageBrowser.batch.propScheduledDate'),
  }
  const isDateKey = DATE_KEYS.has(propertyKey as PropertyKey)
  // Reserved value options (todo_state / priority). The leading Clear entry
  // maps to `null`; date keys use the date input instead of this list.
  const valueOptions = useMemo<{ value: string; label: string }[]>(() => {
    const clear = { value: CLEAR_VALUE, label: t('pageBrowser.batch.clearValue') }
    if (propertyKey === 'todo_state') {
      return [
        clear,
        { value: 'TODO', label: t('pageBrowser.batch.todoTodo') },
        { value: 'DOING', label: t('pageBrowser.batch.todoDoing') },
        { value: 'DONE', label: t('pageBrowser.batch.todoDone') },
      ]
    }
    if (propertyKey === 'priority') {
      return [
        clear,
        { value: '1', label: t('pageBrowser.batch.priorityHigh') },
        { value: '2', label: t('pageBrowser.batch.priorityMedium') },
        { value: '3', label: t('pageBrowser.batch.priorityLow') },
      ]
    }
    return []
  }, [propertyKey, t])

  // Move-to-space targets exclude the current space (moving to where the
  // pages already live is a no-op).
  const moveTargets = availableSpaces.filter((s) => s.id !== currentSpaceId)

  // A single toggle: when every selected page is already starred, the button
  // unstars them all; otherwise it stars the whole selection. Clicking then
  // writes the batch (localStorage, via the hook) and clears the selection.
  const allStarred = useMemo(
    () => selectedIds.length > 0 && selectedIds.every((id) => starredIds.has(id)),
    [selectedIds, starredIds],
  )

  const handleToggleStar = useCallback(() => {
    if (selectedIds.length === 0) return
    // Pure-FE: `setMany` persists to localStorage and broadcasts the change
    // (registry write, #2666), so no `notify` / `onMutated` is needed.
    setMany(selectedIds, !allStarred)
    onClearSelection()
  }, [selectedIds, allStarred, setMany, onClearSelection])

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
    setPropertyKey('')
    setPropertyValue('')
  }, [])

  // Undo for the batch trash. The selection is cleared as soon as the trash
  // succeeds, so the id list is captured at call time rather than read back off
  // `selectedIds`. `restoreBlocksByIds` is the same list-accepting IPC
  // `usePageDeleteAction.handleUndo` uses; it cascade-restores each root's
  // subtree, which is exactly what `deleteBlocksByIds` cascaded away.
  const handleUndoTrash = useCallback(
    (ids: string[]) => {
      commands
        .restoreBlocksByIds(ids)
        .then(unwrap)
        .then(() => {
          onMutated()
          notify.success(t('pageBrowser.batch.trashUndone', { count: ids.length }))
        })
        .catch((err: unknown) => {
          logger.error('PageBrowserBatchToolbar', 'bulk trash undo failed', { ids }, err)
          notify.error(t('pageBrowser.batch.trashUndoFailed'))
        })
    },
    [onMutated, t],
  )

  const handleTrash = useCallback(async () => {
    if (selectedIds.length === 0 || busy) return
    const ids = [...selectedIds]
    setBusy(true)
    try {
      const count = await deleteBlocksByIds(ids)
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.trashed', { count }), {
        action: { label: t('action.undo'), onClick: () => handleUndoTrash(ids) },
      })
    } catch (err) {
      logger.error('PageBrowserBatchToolbar', 'bulk trash failed', { count: ids.length }, err)
      notify.retry(t('pageBrowser.batch.trashFailed'), () => {
        void handleTrash()
      })
    } finally {
      setBusy(false)
    }
  }, [selectedIds, busy, onClearSelection, onMutated, handleUndoTrash, t])

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

  // Whether the current property/value selection is confirmable. Date keys
  // are always confirmable (an empty date clears); reserved-value keys need
  // a chosen option (a real value or the Clear sentinel).
  const canSetProperty = propertyKey !== '' && (isDateKey || propertyValue !== '')

  const handleSetProperty = useCallback(async () => {
    if (selectedIds.length === 0 || propertyKey === '' || busy) return
    // Resolve the outgoing value: date keys pass the ISO string (empty →
    // clear); reserved-value keys map the Clear sentinel to `null`.
    const value: string | null = isDateKey
      ? propertyValue === ''
        ? null
        : propertyValue
      : propertyValue === CLEAR_VALUE
        ? null
        : propertyValue
    setBusy(true)
    try {
      const count = await setPropertyBatch(selectedIds, propertyKey, value)
      closePickers()
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.propertySet', { count }))
    } catch (err) {
      logger.error(
        'PageBrowserBatchToolbar',
        'bulk set-property failed',
        { count: selectedIds.length, key: propertyKey },
        err,
      )
      notify.error(t('pageBrowser.batch.setPropertyFailed'))
    } finally {
      setBusy(false)
    }
  }, [
    selectedIds,
    propertyKey,
    propertyValue,
    isDateKey,
    busy,
    closePickers,
    onClearSelection,
    onMutated,
    t,
  ])

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
        onClick={() => setTrashConfirmOpen(true)}
        disabled={busy}
        data-testid="page-batch-trash-btn"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t('pageBrowser.batch.trash')}
      </Button>

      {/* Ctrl/Cmd+A selects every loaded page and the backend cascades the
          soft-delete over each selected root's whole subtree, so this gets the
          same confirm the single-page delete and the Trash batch actions get.
          Renders nothing inline while closed (Radix portals the open dialog). */}
      <ConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        titleKey="pageBrowser.batch.trashConfirmTitle"
        descriptionKey="pageBrowser.batch.trashConfirmDescription"
        confirmKey="pageBrowser.batch.trashConfirmAction"
        values={{ count: selectedIds.length }}
        variant="destructive"
        onConfirm={handleTrash}
        className="page-batch-trash-confirm"
      />

      {/* Star / unstar the whole selection (pure localStorage). One toggle:
          unstars when every selected page is already starred, else stars. */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleToggleStar}
        aria-label={
          allStarred ? t('pageBrowser.batch.unstarSelected') : t('pageBrowser.batch.starSelected')
        }
        title={
          allStarred ? t('pageBrowser.batch.unstarSelected') : t('pageBrowser.batch.starSelected')
        }
        data-testid={allStarred ? 'page-batch-unstar-btn' : 'page-batch-star-btn'}
      >
        {allStarred ? (
          <StarOff className="h-3.5 w-3.5" />
        ) : (
          <Star className="h-3.5 w-3.5" fill="none" />
        )}
        {allStarred ? t('pageBrowser.batch.unstar') : t('pageBrowser.batch.star')}
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

      {/* Set-property action: reveals a property picker + value control, then
          confirms via `setPropertyBatch`. */}
      {activePicker === 'property' ? (
        <span className="flex items-center gap-2" data-testid="page-batch-property-picker">
          <Select
            value={propertyKey}
            onValueChange={(v) => {
              setPropertyKey(v)
              setPropertyValue('')
            }}
          >
            <SelectTrigger
              size="sm"
              className="min-w-40"
              aria-label={t('pageBrowser.batch.propertyPlaceholder')}
              data-testid="page-batch-property-select"
            >
              <SelectValue placeholder={t('pageBrowser.batch.propertyPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {PROPERTY_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {propertyLabels[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {propertyKey !== '' &&
            (isDateKey ? (
              <input
                type="date"
                value={propertyValue}
                onChange={(e) => setPropertyValue(e.target.value)}
                aria-label={t('pageBrowser.batch.datePlaceholder')}
                data-testid="page-batch-property-date"
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              />
            ) : (
              <Select value={propertyValue} onValueChange={setPropertyValue}>
                <SelectTrigger
                  size="sm"
                  className="min-w-40"
                  aria-label={t('pageBrowser.batch.valuePlaceholder')}
                  data-testid="page-batch-property-value-select"
                >
                  <SelectValue placeholder={t('pageBrowser.batch.valuePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {valueOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ))}

          <Button
            variant="default"
            size="sm"
            onClick={handleSetProperty}
            disabled={busy || !canSetProperty}
            data-testid="page-batch-property-confirm"
          >
            {t('pageBrowser.batch.confirmSetProperty')}
          </Button>
          <Button variant="ghost" size="sm" onClick={closePickers} disabled={busy}>
            {t('pageBrowser.batch.cancel')}
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setActivePicker('property')}
          disabled={busy}
          data-testid="page-batch-set-property-btn"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('pageBrowser.batch.setProperty')}
        </Button>
      )}
    </BatchActionToolbar>
  )
}
