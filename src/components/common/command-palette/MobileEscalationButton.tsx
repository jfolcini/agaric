/**
 * MobileEscalationButton — prominent, always-visible
 * escalation CTA pinned beneath the CommandList on the mobile all-pages
 * sheet. Extracted from `PaletteBody` in CommandPalette.tsx.
 *
 * Styled as a bordered, elevated box (not a muted footer row) so the
 * path to the full search view — filters, regex, history — is
 * discoverable even on a cold open with an empty query. Two lines: an
 * emphasized title with a trailing chevron + a muted hint.
 * Sibling-after-list placement loses cmdk's Enter-to-select binding, but
 * touch users tap.
 */

import { ChevronRight } from 'lucide-react'
import type React from 'react'
import type { useTranslation } from 'react-i18next'

export function MobileEscalationButton({
  onEscalate,
  t,
}: {
  onEscalate: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onEscalate}
      data-testid="palette-escalation-footer"
      aria-label={t('searchSheet.escalateLabel')}
      className="m-3 flex min-h-11 items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left shadow-(--shadow-resting) hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-ring-visible"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1 text-sm font-medium text-foreground">
          <span className="truncate">{t('searchSheet.escalateCtaTitle')}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {t('searchSheet.escalateCtaHint')}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
