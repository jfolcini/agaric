/**
 * RefEditor — renders a popover-driven page picker for ref-typed properties.
 *
 * Trigger button shows the resolved title (or the empty-state placeholder);
 * the popover hosts a search input + a scrollable list of pages with a
 * Spinner gated on the per-page save promise (UX-272 sub-fix 8). When the
 * `onCreateNewPage` callback is wired and the search has content, the empty
 * state offers a `t('properties.createNewPageAction', { name })` affordance (UX-272 sub-fix 1).
 */

import { FileSearch, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'

import type { PropertyRow } from '../../lib/tauri'
import { useResolveStore } from '../../stores/resolve'
import { EmptyState } from '../EmptyState'
import type { RefPickerEditorState } from './usePropertyRowEditor'

export interface RefEditorProps {
  prop: PropertyRow
  state: RefPickerEditorState
  ariaLabel: string
  hasCreateNewPage: boolean
}

export function RefEditor({ prop, state, ariaLabel, hasCreateNewPage }: RefEditorProps) {
  const { t } = useTranslation()
  const resolveTitle = useResolveStore((s) => s.resolveTitle)
  const {
    open,
    setOpen,
    search,
    setSearch,
    filteredPages,
    savingRefPageId,
    handleOpen,
    handleSelectPage,
    handleCreateNewPage,
  } = state
  const refDisplayTitle = prop.value_ref ? resolveTitle(prop.value_ref) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full justify-start text-xs font-normal"
          onClick={handleOpen}
          aria-label={ariaLabel}
        >
          {refDisplayTitle || (
            <span className="text-muted-foreground">{t('block.searchPages')}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 space-y-1 p-2 max-w-[calc(100vw-2rem)]"
        aria-label={t('block.refPickerLabel')}
      >
        <Input
          className="h-7 text-xs"
          placeholder={t('block.searchPages')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t('block.searchPages')}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- this search input is the first element of the ref-picker popover content that opens on demand; focusing it lets the user start filtering pages immediately without an extra click/tab
          autoFocus
        />
        <ScrollArea className="max-h-48">
          <div className="flex flex-col gap-0.5" aria-busy={savingRefPageId !== null}>
            {filteredPages.length === 0 ? (
              <RefPickerEmpty
                search={search}
                hasCreateNewPage={hasCreateNewPage}
                onCreateNewPage={handleCreateNewPage}
              />
            ) : (
              filteredPages.map((page) => (
                <RefPageRow
                  key={page.id}
                  pageId={page.id}
                  content={page.content}
                  saving={savingRefPageId === page.id}
                  disabled={savingRefPageId !== null}
                  onClick={() => handleSelectPage(page)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

interface RefPickerEmptyProps {
  search: string
  hasCreateNewPage: boolean
  onCreateNewPage: () => void
}

function RefPickerEmpty({ search, hasCreateNewPage, onCreateNewPage }: RefPickerEmptyProps) {
  const { t } = useTranslation()
  const trimmed = search.trim()
  const action =
    hasCreateNewPage && trimmed ? (
      <Button
        variant="ghost"
        size="xs"
        className="mt-2 gap-1 text-muted-foreground"
        onClick={onCreateNewPage}
        data-testid="ref-picker-create-page"
      >
        <Plus className="h-3 w-3" />
        {t('properties.createNewPageAction', { name: trimmed })}
      </Button>
    ) : undefined
  return (
    <EmptyState
      icon={FileSearch}
      message={t('properties.refPickerEmptyTitle')}
      description={t('properties.refPickerEmptyDescription')}
      compact
      action={action}
    />
  )
}

interface RefPageRowProps {
  pageId: string
  content: string | null
  saving: boolean
  disabled: boolean
  onClick: () => void
}

function RefPageRow({ content, saving, disabled, onClick }: RefPageRowProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent truncate flex items-center gap-1.5 disabled:opacity-60"
      onClick={onClick}
      disabled={disabled}
      aria-busy={saving}
    >
      {saving && <Spinner size="sm" aria-label={t('properties.savingRefValue')} />}
      <span className="truncate">{content || t('block.untitled')}</span>
    </button>
  )
}
