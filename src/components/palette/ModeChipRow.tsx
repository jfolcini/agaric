/**
 * Mode-chip row + footer hint — the chrome above/below the palette
 * input. Extracted from CommandPalette.tsx (#751).
 */

import { ArrowLeftRight } from 'lucide-react'
import type React from 'react'
import type { useTranslation } from 'react-i18next'

import { Kbd } from '@/components/ui/kbd'
import type { PaletteMode } from '@/stores/useCommandPaletteStore'

/**
 * Mode-chip row — the visible affordance for switching modes. Renders
 * as a thin header strip above the input.
 *
 * PEND-61 CR — clicking the chip flips the store mode WITHOUT
 * writing to the input. The `>` input prefix remains a one-way entry
 * shortcut (handled by the mode router in `PaletteBody`); the chip is
 * the way back to search.
 *
 * PEND-67 Phase 6 — toggling no longer clears the query. The store
 * remembers a query per mode (`queryByMode`); `setMode` restores it
 * so flipping back to the previous mode feels responsive, not
 * destructive (VSCode Cmd+P / Cmd+Shift+P parity).
 *
 * PEND-67 Phase 3 — with 4 modes (search / commands / tags / help)
 * a 4-cycle on the chip would force users to click 3 times to escape
 * any non-search mode. The plan suggested a cycle but Open Question 1
 * acknowledges this is awkward; we choose single-step exit semantics
 * instead. From search the chip enters commands (the original
 * affordance); from any other mode it returns to search. Tags and
 * help are entered via the `#` / `?` prefixes, surfaced in the
 * `modeHint` text on the search-mode chip row.
 */
export function ModeChipRow({
  mode,
  setMode,
  t,
}: {
  mode: PaletteMode
  setMode: (m: PaletteMode) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  function toggleMode() {
    if (mode === 'search') {
      setMode('commands')
    } else {
      setMode('search')
    }
  }
  const label =
    mode === 'commands'
      ? t('palette.modeCommands')
      : mode === 'tags'
        ? t('palette.modeTags')
        : mode === 'help'
          ? t('palette.modeHelp')
          : t('palette.modeSearch')
  // Only the search-mode hint surfaces the prefix vocabulary —
  // other modes don't benefit from showing it.
  const hint = mode === 'search' ? t('palette.modeHint') : t('palette.modeBackHint')
  return (
    <div
      className="flex items-center justify-between border-b px-3 py-1.5 text-xs"
      data-testid="palette-mode-row"
    >
      <button
        type="button"
        onClick={toggleMode}
        className="inline-flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground hover:bg-muted/60 focus-ring-visible"
        aria-label={t('palette.modeChipLabel', { mode: label })}
        data-testid="palette-mode-chip"
      >
        {/* PEND-61 CR-2 — `ArrowLeftRight` reads as a bidirectional
            toggle. `ChevronRight` previously implied a one-way
            drill-in, which is the wrong affordance signal. */}
        <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
        {label}
      </button>
      {/* PEND-61 CR — drop `aria-hidden` so SR users can discover the
          prefix shortcuts. The hint is short and informational, so it
          lives in the visible header rather than a tooltip. */}
      <span className="text-muted-foreground">{hint}</span>
    </div>
  )
}

/**
 * Footer hint — surfaces the modifier-key affordances (Enter / ⌘Enter
 * / Esc) as `<kbd>` chips so power users can scan the shortcuts
 * without reading prose. Hidden in link mode and commands mode
 * because the modifier-key vocabulary changes per mode.
 *
 * PEND-61 CR-2 — round-1 shipped this as a flat `text-[10px]` string;
 * `<kbd>`-rendered chord chips match Raycast / Linear and respect
 * the project's 11px typography floor.
 */
export function PaletteFooterHint({
  t,
}: {
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  return (
    <div
      className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="palette-footer-hint"
    >
      {/* #1005 — canonical <Kbd>. The adjacent text labels the action, so
          the glyph chips are decorative → aria-hidden. */}
      <span className="inline-flex items-center gap-1">
        <Kbd aria-hidden="true">↵</Kbd>
        {t('palette.footerHintOpen')}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd aria-hidden="true">⌘↵</Kbd>
        {t('palette.footerHintNewTab')}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd aria-hidden="true">esc</Kbd>
        {t('palette.footerHintClose')}
      </span>
    </div>
  )
}
