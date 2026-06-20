/**
 * Commands-mode body (+ the `ShortcutChips` row affordance). Extracted
 * from CommandPalette.tsx (#751).
 */

import { RotateCcw } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { useTranslation } from 'react-i18next'

import { CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { formatChordTokens } from '@/lib/keyboard-config/format-chord'
import { getShortcutKeys } from '@/lib/keyboard-config/storage'
import { PALETTE_COMMANDS, type PaletteCommandSpec } from '@/lib/palette-commands'
import { addRecentCommand, getRecentCommands } from '@/lib/recent-commands'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

/**
 * Right-aligned chord chip group rendered inside a `<CommandItem>`.
 * Reads live from `getShortcutKeys` so a rebind takes effect on the
 * next render. Returns null when the binding is empty (e.g. a command
 * without a `shortcutId` or a deleted-then-not-rebound binding) so the
 * row layout stays consistent — no empty `<span>` placeholder.
 */
function ShortcutChips({ shortcutId }: { shortcutId: string }): React.ReactElement | null {
  const keys = getShortcutKeys(shortcutId)
  const tokens = formatChordTokens(keys)
  if (tokens.length === 0) return null
  return (
    <span
      className="ml-auto inline-flex items-center gap-1"
      aria-hidden="true"
      data-testid={`palette-cmd-shortcut-${shortcutId}`}
    >
      {tokens.map((tok) => (
        // Tokens within a chord are unique in practice (Ctrl+Shift+F,
        // not Ctrl+Ctrl+F). Using `tok` as key avoids the index-as-key
        // lint while staying stable across rebind re-renders. #1004 — the
        // canonical <Kbd> carries its own bg/fg so the chip stays legible
        // on a selected (`bg-accent`) command row.
        <Kbd key={tok}>{tok}</Kbd>
      ))}
    </span>
  )
}

/**
 * Commands-mode body — v1 ships a small static registry of
 * navigation + action commands. Future modes (`nav`, `spaces`,
 * `agents`, `settings`) move into their own files; the registry is
 * intentionally inline here to keep v1 footprint small.
 *
 * cmdk filters via its own `value`-string match because we set
 * `shouldFilter={false}` on the root — so we pass the user's
 * post-`>` query down explicitly and filter the registry here, then
 * render only the surviving commands.
 */
export function CommandsModeBody({
  onEscalate,
  onClose,
  t,
}: {
  onEscalate: (q: string) => void
  onClose: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  // The mode router at the parent (`PaletteBody`) has
  // already stripped the leading `>` from the store query when the
  // user typed it as the entry shortcut. Filtering by `query` directly
  // is correct; calling `commandsModeQuery(query)` here would shift
  // off another character (so `>set` filtered as `et`, missing the
  // `go-settings` row).
  const query = useCommandPaletteStore((s) => s.query)
  const filter = query.toLowerCase().trim()

  // Phase 8 — registry hoisted to `lib/palette-commands.ts`
  // so the global `runLastCommand` shortcut can execute by id without
  // mounting the palette body. Here we adapt each spec into the
  // shape the rest of the body expects: a flat `label` (resolved via
  // `t()`) + a 0-arg `run` closed over `onClose` / `onEscalate`.
  type RenderedCommand = Omit<PaletteCommandSpec, 'labelKey' | 'run'> & {
    label: string
    run: () => void
  }
  const commands: ReadonlyArray<RenderedCommand> = useMemo(
    () =>
      PALETTE_COMMANDS.map((c) => ({
        ...c,
        label: t(c.labelKey),
        run: () => c.run({ onClose, onEscalate }),
      })),
    [t, onEscalate, onClose],
  )

  const filtered = useMemo(
    () =>
      filter.length === 0
        ? commands
        : commands.filter((c) => c.label.toLowerCase().includes(filter)),
    [commands, filter],
  )

  // Phase 2 — Recent commands strip. Only rendered when the
  // filter is empty (typed input hides it so the registry filter has
  // the floor). Read once on mount; the list is small and the palette
  // re-mounts every open.
  const [recents, setRecents] = useState<ReturnType<typeof getRecentCommands>>([])
  useEffect(() => {
    setRecents(getRecentCommands())
  }, [])

  // Build the visible recent rows by joining ids against the registry.
  // Recents whose command id no longer exists in the registry (stale
  // localStorage from an older build) are silently skipped.
  const recentRows = useMemo(() => {
    if (filter.length > 0) return []
    const byId = new Map(commands.map((c) => [c.id, c]))
    return recents
      .map((r) => byId.get(r.id))
      .filter((c): c is (typeof commands)[number] => c != null)
  }, [recents, commands, filter])

  // Wrap each `run` so the command id is recorded before the handler
  // closes the palette. The store is module-level state, so a re-render
  // inside `setRecents` from a closed palette is harmless.
  const runWithTracking = (c: (typeof commands)[number]) => () => {
    addRecentCommand(c.id)
    c.run()
  }

  if (filtered.length === 0 && recentRows.length === 0) {
    return (
      <CommandEmpty data-testid="palette-commands-empty">{t('palette.commandsEmpty')}</CommandEmpty>
    )
  }

  const navigateItems = filtered.filter((c) => c.category === 'navigate')
  const actionItems = filtered.filter((c) => c.category === 'action')

  return (
    <>
      {recentRows.length > 0 && (
        <CommandGroup
          heading={t('palette.recentCommandsTitle')}
          data-testid="palette-commands-recent"
        >
          {recentRows.map((c) => (
            <CommandItem
              key={`recent-${c.id}`}
              value={`cmd-recent:${c.id}`}
              onSelect={runWithTracking(c)}
              data-testid={`palette-cmd-recent-${c.id}`}
              className="gap-2"
            >
              <RotateCcw
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{c.label}</span>
              {c.shortcutId != null && <ShortcutChips shortcutId={c.shortcutId} />}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {navigateItems.length > 0 && (
        <CommandGroup
          heading={t('palette.cmdGroupNavigate')}
          data-testid="palette-commands-navigate"
        >
          {navigateItems.map((c) => (
            <CommandItem
              key={c.id}
              value={`cmd:${c.id}`}
              onSelect={runWithTracking(c)}
              data-testid={`palette-cmd-${c.id}`}
              className="gap-2"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{c.label}</span>
              {c.shortcutId != null && <ShortcutChips shortcutId={c.shortcutId} />}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {actionItems.length > 0 && (
        <CommandGroup heading={t('palette.cmdGroupAction')} data-testid="palette-commands-action">
          {actionItems.map((c) => (
            <CommandItem
              key={c.id}
              value={`cmd:${c.id}`}
              onSelect={runWithTracking(c)}
              data-testid={`palette-cmd-${c.id}`}
              className="gap-2"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>{c.label}</span>
              {c.shortcutId != null && <ShortcutChips shortcutId={c.shortcutId} />}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  )
}
