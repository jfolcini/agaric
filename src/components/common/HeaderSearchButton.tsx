/**
 * HeaderSearchButton — the desktop header's visible way into the Ctrl+K
 * command palette. Mobile chrome has `SearchSheetTrigger` in the same slot;
 * `App.tsx` mounts exactly one of the two.
 *
 * Opens the palette through the store `useAppKeyboardShortcuts` opens it with,
 * so the click and the keystroke can never diverge. Below `lg` the word drops
 * and the button is the magnifier alone; the accessible name stays.
 */

import { Search } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { KbdChord } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getShortcutKeys, toAriaKeyshortcuts } from '@/lib/keyboard-config'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

export function HeaderSearchButton(): React.ReactElement {
  const { t } = useTranslation()
  const paletteKeys = getShortcutKeys('paletteOpen')
  const findKeys = getShortcutKeys('findInPage')
  const label = t('headerSearch.label')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground max-lg:min-w-8 max-lg:px-0 [@media(pointer:coarse)]:min-w-11"
          aria-label={label}
          aria-keyshortcuts={toAriaKeyshortcuts(paletteKeys)}
          data-testid="header-search-button"
          onClick={() => useCommandPaletteStore.getState().open$()}
        >
          <Search aria-hidden="true" />
          <span className="max-lg:hidden">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-1">
          <span>
            {label} {/* aria-keyshortcuts already announces this chord. */}
            <span aria-hidden="true">
              <KbdChord keys={paletteKeys} className="ml-1" />
            </span>
          </span>
          <span>
            {t('findInPage.toolbarLabel')} <KbdChord keys={findKeys} className="ml-1" />
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
