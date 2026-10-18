/**
 * SavedViews — #1460 saved-views picker for the advanced-query surface.
 *
 * Lists the active space's saved views (`PREFERENCES.savedQueryViews`, written
 * through `src/lib/saved-query-views.ts`). Load parses the view's stored spec
 * and hydrates the builder store; rename and delete rewrite the list.
 */

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { RenameDialog } from '@/components/dialogs/RenameDialog'
import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'
import { PREFERENCES, type SavedQueryView, usePreference } from '@/lib/preferences'
import { deleteSavedQueryView, renameSavedQueryView } from '@/lib/saved-query-views'
import { parseQuerySpec, useAdvancedQueryStore } from '@/stores/advancedQuery'

export interface SavedViewsProps {
  /** Active space key (`__legacy__` when no space). Views are listed and loaded here. */
  spaceKey: string
}

export function SavedViews({ spaceKey }: SavedViewsProps): React.ReactElement {
  const { t } = useTranslation()
  const loadView = useAdvancedQueryStore((s) => s.loadView)
  const [views] = usePreference(PREFERENCES.savedQueryViews, spaceKey)

  const [renameTarget, setRenameTarget] = useState<SavedQueryView | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SavedQueryView | null>(null)

  const handleLoad = (view: SavedQueryView): void => {
    try {
      loadView(spaceKey, parseQuerySpec(view.spec))
      notify.success(t('advancedQuery.savedViews.loaded', { name: view.name }))
    } catch (err) {
      notify.error(err instanceof Error ? err : t('advancedQuery.savedViews.loadError'))
    }
  }

  const handleRename = (name: string): void => {
    if (renameTarget == null) return
    renameSavedQueryView(spaceKey, renameTarget.id, name)
    notify.success(t('advancedQuery.savedViews.renamed', { name }))
  }

  const handleDelete = (): void => {
    if (deleteTarget == null) return
    deleteSavedQueryView(spaceKey, deleteTarget.id)
    notify.success(t('advancedQuery.savedViews.deleted', { name: deleteTarget.name }))
  }

  return (
    <section
      className="advanced-query-saved-views flex flex-col gap-2"
      aria-label={t('advancedQuery.savedViews.label')}
      data-testid="advanced-query-saved-views"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {t('advancedQuery.savedViews.label')}
      </h3>

      {views.length === 0 && <EmptyState message={t('advancedQuery.savedViews.empty')} compact />}

      {views.length > 0 && (
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
                  onClick={() => handleLoad(view)}
                  aria-label={t('advancedQuery.savedViews.loadTitle', { name: view.name })}
                >
                  {t('advancedQuery.savedViews.load')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setRenameTarget(view)}
                  aria-label={t('advancedQuery.savedViews.renameTitle', { name: view.name })}
                >
                  {t('advancedQuery.savedViews.rename')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setDeleteTarget(view)}
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
        onConfirm={handleRename}
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
        titleKey="advancedQuery.savedViews.delete"
        descriptionKey="advancedQuery.savedViews.deleteConfirm"
        confirmKey="advancedQuery.savedViews.delete"
        values={{ name: deleteTarget?.name ?? '' }}
        onConfirm={handleDelete}
      />
    </section>
  )
}
