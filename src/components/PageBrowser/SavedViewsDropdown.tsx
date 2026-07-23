/**
 * SavedViewsDropdown — list/apply/delete UI for named Pages-view snapshots
 * (#2003 piece 1). Slotted into `PageBrowserHeader`'s search/sort/density
 * row, next to the density `Select`.
 *
 * Pure presentational + its own transient popover/dialog-open state (mirrors
 * `PageHeaderMenu`'s `moveSubmenuOpen` — it's idiomatic in this codebase for
 * a menu-shaped component to own its own open state rather than lifting it).
 * All persisted state (the views list, save/delete) lives in the parent via
 * `useSavedPagesViews`, passed in as props.
 */

import { Bookmark, Check, Save, Trash2 } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SaveViewDialog } from '@/components/PageBrowser/SaveViewDialog'
import { Button } from '@/components/ui/button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import type { SavedPagesView } from '@/lib/preferences'

export interface SavedViewsDropdownProps {
  views: SavedPagesView[]
  /** The saved view matching the current tuple, or `null` if none matches. */
  activeView: SavedPagesView | null
  onApply: (view: SavedPagesView) => void
  onDelete: (view: SavedPagesView) => void
  /** Fires once the user confirms a name in the save dialog. */
  onSaveCurrentView: (name: string) => void
}

export function SavedViewsDropdown({
  views,
  activeView,
  onApply,
  onDelete,
  onSaveCurrentView,
}: SavedViewsDropdownProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-auto min-w-[7rem]"
            aria-label={
              activeView
                ? t('pageBrowser.savedViews.triggerActive', { name: activeView.name })
                : t('pageBrowser.savedViews.trigger')
            }
            data-testid="saved-views-trigger"
          >
            <Bookmark
              className="h-4 w-4 text-muted-foreground"
              fill={activeView ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
            <span className="truncate max-w-[8rem]">
              {activeView ? activeView.name : t('pageBrowser.savedViews.trigger')}
            </span>
          </Button>
        </PopoverTrigger>
        <MenuPopoverContent
          align="start"
          className="p-1"
          data-testid="saved-views-menu"
          aria-label={t('pageBrowser.savedViews.trigger')}
        >
          {views.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('pageBrowser.savedViews.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5 list-none m-0 p-0 max-h-64 overflow-y-auto">
              {views.map((view) => {
                const isActive = activeView?.id === view.id
                return (
                  <li key={view.id} className="flex items-center gap-0.5">
                    <PopoverMenuItem
                      active={isActive}
                      aria-current={isActive ? 'true' : undefined}
                      className="flex items-center gap-2 flex-1 min-w-0"
                      onClick={() => {
                        onApply(view)
                        setOpen(false)
                      }}
                      aria-label={t('pageBrowser.savedViews.apply', { name: view.name })}
                    >
                      {isActive ? (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate">{view.name}</span>
                    </PopoverMenuItem>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={t('pageBrowser.savedViews.delete', { name: view.name })}
                      onClick={() => onDelete(view)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          <hr className="my-1 h-px bg-border border-none" />
          <PopoverMenuItem
            className="flex items-center gap-2"
            onClick={() => {
              setOpen(false)
              setSaveDialogOpen(true)
            }}
            data-testid="saved-views-save-current"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {t('pageBrowser.savedViews.saveCurrentView')}
          </PopoverMenuItem>
        </MenuPopoverContent>
      </Popover>
      <SaveViewDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        onConfirm={onSaveCurrentView}
      />
    </>
  )
}
