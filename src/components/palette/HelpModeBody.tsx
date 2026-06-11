/**
 * Help-mode body (PEND-67 Phase 3 — `?` prefix → keyboard shortcut
 * catalog). Extracted from CommandPalette.tsx (#751).
 */

import { HelpCircle } from 'lucide-react'
import type React from 'react'
import { useMemo } from 'react'
import type { useTranslation } from 'react-i18next'

import { CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command'
import { getCurrentShortcuts } from '@/lib/keyboard-config/storage'
import { renderKeys } from '@/lib/render-keyboard-shortcut'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

/**
 * Help-mode body — renders the keyboard shortcut catalog grouped by
 * category. Reads `getCurrentShortcuts()` once on mount (the catalog
 * is static; user overrides are picked up on next palette open since
 * the palette re-mounts every time it opens).
 *
 * Selecting a row closes the palette — there is no "run this
 * shortcut from here" action because some shortcuts only fire in
 * context-bound conditions (e.g. only inside the editor, only with
 * the date picker open).
 */
export function HelpModeBody({
  onClose,
  t,
}: {
  onClose: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  const query = useCommandPaletteStore((s) => s.query)
  const filter = query.toLowerCase().trim()

  const shortcuts = useMemo(() => getCurrentShortcuts(), [])
  const filtered = useMemo(() => {
    if (filter.length === 0) return shortcuts
    return shortcuts.filter(
      (s) =>
        t(s.description).toLowerCase().includes(filter) || s.keys.toLowerCase().includes(filter),
    )
  }, [shortcuts, filter, t])

  // Group by category preserving first-seen order so the visible
  // ordering tracks the catalog's authoring order.
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof filtered>()
    for (const s of filtered) {
      const arr = groups.get(s.category) ?? []
      arr.push(s)
      groups.set(s.category, arr)
    }
    return Array.from(groups.entries())
  }, [filtered])

  if (filtered.length === 0) {
    return <CommandEmpty data-testid="palette-help-empty">{t('palette.helpEmpty')}</CommandEmpty>
  }

  return (
    <>
      {grouped.map(([category, items]) => (
        <CommandGroup
          key={category}
          heading={t(category)}
          data-testid={`palette-help-group-${category}`}
        >
          {items.map((s) => (
            <CommandItem
              key={s.id}
              value={`help:${s.id}`}
              onSelect={onClose}
              data-testid={`palette-help-${s.id}`}
              className="gap-2"
            >
              <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate">{t(s.description)}</span>
              {/* Use the shared `renderKeys` helper because catalog
                  bindings include `/`-alternatives (e.g. `Arrow Up /
                  Left`) and multi-word tokens (`Arrow Up`) that the
                  glyph-mapping `ShortcutChips` does not handle. The
                  styling matches the standalone KeyboardShortcuts
                  dialog so users moving between surfaces see one
                  consistent chord layout. */}
              <span className="ml-auto inline-flex items-center" aria-hidden="true">
                {renderKeys(s.keys)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  )
}
