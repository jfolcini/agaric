/**
 * SavedViews — #1460 saved-views picker for the advanced-query surface.
 *
 * A saved view is a plain content block (the block's CONTENT is the view's
 * display name) carrying two properties set through the existing `setProperty`
 * wrapper:
 *   - `view_type = 'query-view'`  — the marker that makes it discoverable.
 *   - `query_spec = '<JSON>'`     — the serialized {@link SavedQuerySpec} (the
 *                                    compiled `FilterExpr` plus the D2 controls,
 *                                    minus pagination).
 *
 * No special parent and no new Tauri commands: views are created in the current
 * space via `createBlock`, listed via `queryByProperty({ key: 'view_type' })`,
 * loaded by reading the `query_spec` property + hydrating the builder store,
 * renamed via `editBlock` (block content), and deleted via `deleteBlock`. A
 * separate backend change hides these marker blocks from normal listings.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { RenameDialog } from '@/components/dialogs/RenameDialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { notify } from '@/lib/notify'
import { deleteBlock, editBlock, getProperty, queryByProperty } from '@/lib/tauri'
import { parseQuerySpec, useAdvancedQueryStore } from '@/stores/advancedQuery'

/** Marker property key + value identifying a saved query view. */
export const VIEW_TYPE_KEY = 'view_type'
export const QUERY_VIEW_MARKER = 'query-view'
/** Property key holding the serialized {@link SavedQuerySpec} JSON. */
export const QUERY_SPEC_KEY = 'query_spec'

/** A saved view as shown in the picker (block id + display name). */
interface SavedViewItem {
  id: string
  name: string
}

export interface SavedViewsProps {
  /** Active space key (`__legacy__` when no space). Loaded views hydrate here. */
  spaceKey: string
  /**
   * The active space id (or `null`/`undefined` pre-bootstrap) used to scope the
   * `queryByProperty` listing to the current space.
   */
  spaceId: string | null | undefined
  /**
   * Signals the picker to refresh its list (e.g. bumped after a save in the
   * parent). Any change to this value re-runs the listing.
   */
  refreshToken?: number | undefined
}

export function SavedViews({
  spaceKey,
  spaceId,
  refreshToken,
}: SavedViewsProps): React.ReactElement {
  const { t } = useTranslation()
  const loadView = useAdvancedQueryStore((s) => s.loadView)

  const [views, setViews] = useState<SavedViewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(false)
  // Per-row in-flight ids (load / rename / delete) keep the relevant controls
  // disabled while their IPC is outstanding.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SavedViewItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SavedViewItem | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setListError(false)
    try {
      const resp = await queryByProperty({
        key: VIEW_TYPE_KEY,
        valueText: QUERY_VIEW_MARKER,
        spaceId: spaceId ?? null,
        limit: PAGINATION_LIMIT,
      })
      setViews(
        resp.items.map((row) => ({
          id: row.id,
          name: row.content?.trim() ? row.content : t('advancedQuery.savedViews.untitled'),
        })),
      )
    } catch {
      setListError(true)
      setViews([])
    } finally {
      setLoading(false)
    }
  }, [spaceId, t])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshToken])

  const handleLoad = useCallback(
    async (view: SavedViewItem): Promise<void> => {
      setBusyId(view.id)
      try {
        const prop = await getProperty(view.id, QUERY_SPEC_KEY)
        if (prop?.value_text == null) {
          throw new Error('saved view has no query_spec')
        }
        const spec = parseQuerySpec(prop.value_text)
        loadView(spaceKey, spec)
        notify.success(t('advancedQuery.savedViews.loaded', { name: view.name }))
      } catch (err) {
        notify.error(err instanceof Error ? err : t('advancedQuery.savedViews.loadError'))
      } finally {
        setBusyId(null)
      }
    },
    [loadView, spaceKey, t],
  )

  const handleRename = useCallback(
    async (name: string): Promise<void> => {
      if (renameTarget == null) return
      const target = renameTarget
      setBusyId(target.id)
      try {
        await editBlock(target.id, name)
        setViews((prev) => prev.map((v) => (v.id === target.id ? { ...v, name } : v)))
        notify.success(t('advancedQuery.savedViews.renamed', { name }))
      } catch {
        notify.error(t('advancedQuery.savedViews.renameError'))
      } finally {
        setBusyId(null)
      }
    },
    [renameTarget, t],
  )

  const handleDelete = useCallback(async (): Promise<void> => {
    if (deleteTarget == null) return
    const target = deleteTarget
    setBusyId(target.id)
    try {
      await deleteBlock(target.id)
      setViews((prev) => prev.filter((v) => v.id !== target.id))
      notify.success(t('advancedQuery.savedViews.deleted', { name: target.name }))
    } catch {
      notify.error(t('advancedQuery.savedViews.deleteError'))
      // Re-throw so ConfirmDialog stays open for the retry.
      throw new Error('delete failed')
    } finally {
      setBusyId(null)
    }
  }, [deleteTarget, t])

  return (
    <section
      className="advanced-query-saved-views flex flex-col gap-2"
      aria-label={t('advancedQuery.savedViews.label')}
      data-testid="advanced-query-saved-views"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {t('advancedQuery.savedViews.label')}
      </h3>

      {loading && (
        <div className="flex justify-center px-3 py-2">
          <Spinner size="sm" />
        </div>
      )}

      {!loading && listError && (
        <div className="px-1 py-1 text-xs text-destructive" role="alert">
          <span>{t('advancedQuery.savedViews.listError')}</span>
          <Button
            variant="outline"
            size="xs"
            className="ml-2"
            onClick={() => void refresh()}
            aria-label={t('action.retry')}
          >
            {t('action.retry')}
          </Button>
        </div>
      )}

      {!loading && !listError && views.length === 0 && (
        <EmptyState message={t('advancedQuery.savedViews.empty')} compact />
      )}

      {!loading && !listError && views.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="saved-views-list">
          {views.map((view) => (
            <li
              key={view.id}
              className="flex items-center justify-between gap-2 rounded px-1 py-0.5"
              data-testid="saved-view-row"
            >
              <span className="truncate text-sm">{view.name}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void handleLoad(view)}
                  disabled={busyId === view.id}
                  aria-label={t('advancedQuery.savedViews.loadTitle', { name: view.name })}
                >
                  {t('advancedQuery.savedViews.load')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setRenameTarget(view)}
                  disabled={busyId === view.id}
                  aria-label={t('advancedQuery.savedViews.renameTitle', { name: view.name })}
                >
                  {t('advancedQuery.savedViews.rename')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setDeleteTarget(view)}
                  disabled={busyId === view.id}
                  aria-label={t('advancedQuery.savedViews.deleteTitle', { name: view.name })}
                >
                  {t('advancedQuery.savedViews.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <RenameDialog
        open={renameTarget != null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
        onConfirm={(name) => void handleRename(name)}
        currentName={renameTarget?.name ?? ''}
        title={t('advancedQuery.savedViews.rename')}
        description={t('advancedQuery.savedViews.renamePrompt')}
        ariaLabel={t('advancedQuery.savedViews.renamePrompt')}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        variant="destructive"
        title={t('advancedQuery.savedViews.delete')}
        description={t('advancedQuery.savedViews.deleteConfirm', {
          name: deleteTarget?.name ?? '',
        })}
        actionLabel={t('advancedQuery.savedViews.delete')}
        onConfirm={handleDelete}
      />
    </section>
  )
}
