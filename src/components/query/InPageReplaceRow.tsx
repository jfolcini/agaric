/**
 * InPageReplaceRow — the replace row of the in-page find bar (#6608): the
 * replacement text, Replace (the current match, then the next) and Replace
 * all, and what the last replace did. The work is `useInPageReplace`'s.
 */

import type { TFunction } from 'i18next'
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react'
import { useTranslation } from 'react-i18next'

import type { ReplaceOutcome } from '@/components/query/use-in-page-replace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

function outcomeText(t: TFunction, outcome: ReplaceOutcome): string {
  if (outcome.kind === 'failed') return t('findInPage.replaceFailed', { count: outcome.replaced })
  const replaced = t('findInPage.replaced', { count: outcome.replaced })
  const skipped = t('findInPage.replaceSkipped', { count: outcome.skipped })
  if (outcome.skipped === 0) return replaced
  return outcome.replaced === 0 ? skipped : `${replaced} · ${skipped}`
}

export function InPageReplaceRow({
  inputRef,
  value,
  onChange,
  onReplace,
  onReplaceAll,
  onEscape,
  canReplace,
  available,
  busy,
  outcome,
  unreplaceable,
  embedded,
}: {
  inputRef: Ref<HTMLInputElement>
  value: string
  onChange: (value: string) => void
  onReplace: () => void
  onReplaceAll: () => void
  onEscape: () => void
  /** There is a match to replace. */
  canReplace: boolean
  /** The view holds something replace can edit. */
  available: boolean
  busy: boolean
  outcome: ReplaceOutcome | null
  /** Matches found that a replace leaves as they are. */
  unreplaceable: number
  embedded: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const disabled = !available || !canReplace || busy

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (disabled) return
      if ((e.ctrlKey || e.metaKey) && e.altKey) onReplaceAll()
      else onReplace()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onEscape()
    }
  }

  const note = !available
    ? t('findInPage.replaceUnavailable')
    : outcome !== null
      ? outcomeText(t, outcome)
      : unreplaceable > 0
        ? t('findInPage.unreplaceable', { count: unreplaceable })
        : ''

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', embedded ? 'w-full' : 'basis-full')}
      data-testid="in-page-replace-row"
    >
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('findInPage.replacePlaceholder')}
        aria-label={t('findInPage.replaceInputLabel')}
        data-testid="in-page-replace-input"
        className={cn('text-sm', embedded ? 'w-full' : 'h-7 w-48 md:w-64')}
      />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        title={t('findInPage.replaceOneHint')}
        disabled={disabled}
        data-testid="in-page-replace-one"
        onClick={onReplace}
      >
        {t('findInPage.replaceOne')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        title={t('findInPage.replaceAllHint')}
        disabled={disabled}
        data-testid="in-page-replace-all"
        onClick={onReplaceAll}
      >
        {t('findInPage.replaceAll')}
      </Button>
      {busy && <Spinner size="sm" label={t('findInPage.replacing')} />}
      <span
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the toolbar's inline status spans are <span role="status">, as its counter
        role="status"
        aria-live="polite"
        data-testid="in-page-replace-status"
        className={cn(
          'text-xs',
          outcome?.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {note}
      </span>
    </div>
  )
}
