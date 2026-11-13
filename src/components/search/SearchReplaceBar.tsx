/**
 * SearchReplaceBar — the replace row of the search view (#6608): the
 * replacement text, what a replace would touch, and the button that asks
 * before writing. The preview and the run are `useSearchReplace`'s.
 */

import type { TFunction } from 'i18next'
import { Replace } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import type { SearchReplace, SearchReplaceMode } from '@/components/SearchPanel/useSearchReplace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

/** The toggle beside the search modes that opens the replace row. */
export function SearchReplaceToggle({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      variant={open ? 'secondary' : 'outline'}
      size="icon"
      aria-expanded={open}
      aria-label={t('search.replace.toggle')}
      title={t('search.replace.toggle')}
      data-testid="search-replace-toggle"
      onClick={onToggle}
    >
      <Replace aria-hidden="true" />
    </Button>
  )
}

/** What a replace leaves as it is, for the row and for the confirmation. */
function skipNotes(t: TFunction, replace: SearchReplace): string[] {
  const notes: string[] = []
  if (replace.skippedMatches > 0) {
    notes.push(t('findInPage.unreplaceable', { count: replace.skippedMatches }))
  }
  if (replace.skippedNames > 0) {
    notes.push(t('search.replace.namesSkipped', { count: replace.skippedNames }))
  }
  return notes
}

function statusText(t: TFunction, mode: SearchReplaceMode, replace: SearchReplace): string {
  if (mode.unavailable === 'regex') return t('search.replace.noRegex')
  if (mode.unavailable === 'tooShort') return t('search.replace.tooShort')
  if (replace.state.kind === 'loading') return t('search.replace.loading')
  if (replace.state.kind === 'tooMany') return t('search.replace.tooMany')
  const none = replace.state.blocks === 0 ? [t('search.replace.none')] : []
  return [...none, ...skipNotes(t, replace)].join(' · ')
}

/** Renders nothing while the row is closed. */
export function SearchReplaceBar({
  mode,
  replace,
}: {
  mode: SearchReplaceMode
  replace: SearchReplace
}): React.ReactElement | null {
  const { t } = useTranslation()
  // What the dialog asks about, kept as it was when it opened: the preview reloads under it.
  const [confirm, setConfirm] = useState({ open: false, values: {} as Record<string, string> })
  const { state } = replace
  const ready = mode.active && state.kind === 'ready' && state.blocks > 0 && !replace.busy
  const counts =
    state.kind === 'ready'
      ? {
          blocks: t('search.replace.blocks', { count: state.blocks }),
          pages: t('search.replace.pages', { count: state.pages }),
        }
      : null
  if (!mode.open) return null
  const notes = skipNotes(t, replace)
  const ask = (): void => {
    if (!ready || counts === null) return
    setConfirm({
      open: true,
      values: { ...counts, find: mode.find, replacement: mode.replacement },
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="search-replace-bar">
      <Input
        type="text"
        value={mode.replacement}
        onChange={(e) => mode.setReplacement(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ask()
          }
        }}
        placeholder={t('findInPage.replacePlaceholder')}
        aria-label={t('findInPage.replaceInputLabel')}
        data-testid="search-replace-input"
        className="w-full text-sm sm:w-64"
      />
      <Button
        type="button"
        variant="outline"
        disabled={!ready}
        data-testid="search-replace-run"
        onClick={ask}
      >
        {ready && counts !== null ? t('search.replace.run', counts) : t('search.replace.runIdle')}
      </Button>
      {replace.busy && <Spinner size="sm" label={t('findInPage.replacing')} />}
      <output
        aria-live="polite"
        data-testid="search-replace-status"
        className="basis-full text-xs text-muted-foreground"
      >
        {statusText(t, mode, replace)}
      </output>
      <ConfirmDialog
        open={confirm.open}
        onOpenChange={(open) => setConfirm((prev) => ({ ...prev, open }))}
        titleKey="search.replace.confirmTitle"
        descriptionKey={
          confirm.values['replacement'] === ''
            ? 'search.replace.confirmDelete'
            : 'search.replace.confirmBody'
        }
        confirmKey="search.replace.confirm"
        values={confirm.values}
        onConfirm={replace.run}
        actionTestId="search-replace-confirm"
      >
        {notes.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="search-replace-confirm-notes">
            {notes.join(' · ')}
          </p>
        )}
      </ConfirmDialog>
    </div>
  )
}
