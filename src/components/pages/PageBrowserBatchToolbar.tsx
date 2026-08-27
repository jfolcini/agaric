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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { invalidateNameCaches, notifyPageRemoved } from '@/lib/name-change-bus'
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

/**
 * #4008 review note 3 — the batch trash's cap is `MAX_TRASH_BATCH_IDS`
 * (1000), and `notifyPageRemoved` is a synchronous fan-out: every mounted
 * `useBlockResolve` rebuilds its whole cached pages list with `filter` per
 * event, so the cost is `ids x mounted BlockTrees x pages in space` element
 * copies on the UI thread, with no yield in between. Above this many ids the
 * toolbar emits ONE `invalidateNameCaches()` instead, which is O(listeners)
 * and costs a single re-fetch on the next picker read.
 *
 * 25 is measured, not chosen for roundness. Timing the exact production shape
 * (N per-listener lists of `{id, title}` rows, one `filter` per listener per
 * id) on this machine's V8, for a 3,000-page space:
 *
 *   5 mounted trees:   25 ids 6.8ms | 50 ids 12.6ms | 100 ids 25.6ms | 1000 ids 159ms
 *   7 mounted trees:   25 ids 8.8ms | 50 ids 18.3ms | 100 ids 31.1ms
 *
 * 25 is the largest of the measured batch sizes that stays inside one 16.7ms
 * frame in BOTH configurations (8.8ms worst case, ~2x headroom); 50 already
 * misses a frame with 7 trees mounted, which the journal's week view reaches.
 * Below the threshold the per-id events still fire, so the common small delete
 * keeps its precise patch and pays no re-fetch.
 */
export const NAME_CACHE_FANOUT_MAX_IDS = 25

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

  // #3703 item 3 — the trash-failure toast outlives this component. The parent
  // renders the toolbar only while ≥1 page is selected, so clearing the
  // selection UNMOUNTS it while the toast is still on screen with its Retry
  // button. `setTrashConfirmOpen(true)` on an unmounted component is a silent
  // no-op, so Retry looked actionable and did nothing at all. A ref pair is
  // what the toast can still read: `selectedCountRef` for a selection that
  // merely emptied, `mountedRef` because the last render before an unmount
  // still carried the old (non-zero) count.
  const selectedCountRef = useRef(selectedIds.length)
  // Mirrored from a layout effect with no dep array — refreshed on every
  // commit, before any passive effect or user event can read it.
  useLayoutEffect(() => {
    selectedCountRef.current = selectedIds.length
  })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

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
          // #4007 — the restored pages must become offerable again in the
          // `[[` picker, whose cache dropped them on the trash below.
          invalidateNameCaches()
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
    // #4391 — the space this batch belongs to is `currentSpaceId`, the PROP,
    // read below after the awaited delete. What pins it to the value the user
    // acted on is not a local copy (a `const spaceId = currentSpaceId` here
    // would be a no-op: the prop is already closed over from the moment this
    // callback is created, and cannot change under it) but the
    // `currentSpaceId` entry in this `useCallback`'s dep array — that is what
    // makes React hand the click a callback whose closed-over prop is the one
    // rendered at click time, and freezes it for the duration of the await.
    setBusy(true)
    try {
      const count = await deleteBlocksByIds(ids)
      // #4007 — drop every trashed page from the `[[` picker's name cache;
      // it is filled once per space and has no other delete signal.
      // #4008 review note 3 — one event per id is O(ids x listeners x pages)
      // synchronous work; above the measured threshold collapse it into a
      // single invalidation (see `NAME_CACHE_FANOUT_MAX_IDS`).
      //
      // #4391 — no active space (`currentSpaceId == null`) also falls back to
      // a full invalidation: there is no space to scope a per-id event to.
      // Skipping would be equally correct — see the "When the caller has NO
      // active space" section of `src/lib/name-change-bus.ts`, which settles
      // that once instead of leaving each publisher its own precedent.
      if (currentSpaceId == null || ids.length > NAME_CACHE_FANOUT_MAX_IDS) {
        invalidateNameCaches()
      } else {
        for (const id of ids) notifyPageRemoved(id, currentSpaceId)
      }
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.trashed', { count }), {
        action: { label: t('action.undo'), onClick: () => handleUndoTrash(ids) },
      })
    } catch (err) {
      logger.error('PageBrowserBatchToolbar', 'bulk trash failed', { count: ids.length }, err)
      // Retry re-opens the confirm rather than re-firing `ids` directly: the
      // toast can outlive the selection the user had when it failed, and a
      // cascade over a set they can no longer see is exactly what the confirm
      // exists to prevent.
      //
      // #3703 item 3 — but "re-open the confirm" is not possible once the
      // selection is gone: there is nothing to confirm, and the toolbar has
      // been unmounted, so the state setter is a no-op. Silent was better than
      // destructive, and it is still a control that presents as actionable and
      // does nothing. Say why instead.
      notify.retry(t('pageBrowser.batch.trashFailed'), () => {
        if (!mountedRef.current || selectedCountRef.current === 0) {
          notify.error(t('pageBrowser.batch.retryNoSelection'))
          return
        }
        setTrashConfirmOpen(true)
      })
    } finally {
      setBusy(false)
    }
  }, [selectedIds, busy, currentSpaceId, onClearSelection, onMutated, handleUndoTrash, t])

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
    const ids = [...selectedIds]
    setBusy(true)
    try {
      const count = await moveBlocksToSpace(ids, selectedSpaceId)
      // #4450 — the moved pages must stop being offered by the ORIGIN
      // space's `[[` picker cache; `list_all_pages_in_space` is what fills
      // it, and a move publishes nothing to invalidate it otherwise, so a
      // warm cache kept the moved-out pages for the rest of the session.
      // Mirrors `handleTrash` above, which already publishes for the same
      // cache consequence.
      //
      // `currentSpaceId` — the ORIGIN, the space these pages are LEAVING —
      // is the id to scope the event to, not `selectedSpaceId` (the
      // destination): labelling the event with the destination is exactly
      // the "worse than no scoping" mislabelling #4391's docblock warns
      // about, since it would let the origin's still-warm cache go on
      // offering pages it no longer has while never touching it.
      if (currentSpaceId == null || ids.length > NAME_CACHE_FANOUT_MAX_IDS) {
        invalidateNameCaches()
      } else {
        for (const id of ids) notifyPageRemoved(id, currentSpaceId)
      }
      closePickers()
      onClearSelection()
      onMutated()
      notify.success(t('pageBrowser.batch.moved', { count }))
    } catch (err) {
      logger.error('PageBrowserBatchToolbar', 'bulk move failed', { count: ids.length }, err)
      notify.error(t('pageBrowser.batch.moveFailed'))
    } finally {
      setBusy(false)
    }
  }, [
    selectedIds,
    selectedSpaceId,
    busy,
    currentSpaceId,
    closePickers,
    onClearSelection,
    onMutated,
    t,
  ])

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
