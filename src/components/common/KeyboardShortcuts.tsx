/**
 * KeyboardShortcuts — help panel showing all available keyboard shortcuts (UX #9).
 *
 * Triggered by pressing `?` globally (when not editing a block) or via
 * a sidebar button. Uses the Sheet component for a slide-in panel.
 */

import { ChevronRight, Keyboard, Settings as SettingsIcon } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getCurrentShortcuts, getShortcutKeys } from '@/lib/keyboard-config'
import { CLOSE_ALL_OVERLAYS_EVENT } from '@/lib/overlay-events'
import { loadQuickCaptureShortcut } from '@/lib/quick-capture-shortcut'
import { renderKeys } from '@/lib/render-keyboard-shortcut'
import { SETTINGS_ACTIVE_TAB_KEY } from '@/lib/url-state'
import { useNavigationStore } from '@/stores/navigation'

interface ShortcutDef {
  keys: string
  condition?: string
  description: string
  isCustom?: boolean
}

/**
 * Normalise an accelerator string from `tauri-plugin-global-shortcut` format
 * (`Ctrl+Alt+N`, `Cmd+Alt+N`, `Option+Space`) into the space-padded `Ctrl + …`
 * tokens that {@link renderKeys} understands. `Cmd` collapses to `Ctrl` so
 * `renderKeys` substitutes the platform mod key (⌘ on macOS, Ctrl elsewhere);
 * `Option` collapses to `Alt` for the same reason.
 */
function normaliseAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .map((part) => (part === 'Cmd' || part === 'Command' ? 'Ctrl' : part))
    .map((part) => (part === 'Option' ? 'Alt' : part))
    .join(' + ')
}

function buildShortcutGroups(): { category: string; shortcuts: ShortcutDef[] }[] {
  const current = getCurrentShortcuts()
  const groupMap = new Map<string, ShortcutDef[]>()
  for (const s of current) {
    const list = groupMap.get(s.category) ?? []
    list.push({
      keys: s.keys,
      description: s.description,
      ...(s.condition != null && { condition: s.condition }),
      ...(s.isCustom && { isCustom: true }),
    })
    groupMap.set(s.category, list)
  }
  // Quick-capture lives outside `getCurrentShortcuts()` because it has its
  // own per-platform default + storage flow (`loadQuickCaptureShortcut`,
  // owned by SettingsView → QuickCaptureRow). Surface it here so the help
  // sheet announces the OS-global hotkey alongside the in-app bindings.
  groupMap.set('keyboard.category.quickCapture', [
    {
      keys: normaliseAccelerator(loadQuickCaptureShortcut()),
      description: 'keyboard.quickCapture.openDialog',
    },
  ])
  return Array.from(groupMap.entries()).map(([category, shortcuts]) => ({ category, shortcuts }))
}

// #214 Phase 3 — the "Essential" group. A small, hand-curated set of the
// five core triggers a new user needs first. Rendered above the full
// per-category shortcut list (which is generated from the keyboard-config
// catalog) so it is the first thing seen in the help sheet. It reads as a
// quick-start cheat sheet.
//
// #1711 — chord entries (undo, search) carry a `shortcutId` so their keys
// resolve live from the keybinding registry (`getShortcutKeys`), keeping the
// cheat sheet in sync with user rebinds — exactly like the catalog list below
// and like `CommandsModeBody`/`BlockContextMenu`. The platform mod key (⌘ vs
// Ctrl) is substituted at render time by `renderKeys`. The remaining entries
// are literal characters a user types in the editor (`/`, `[[`, `@`), which
// are not rebindable shortcuts, so they keep their literal `keys`.
interface EssentialEntry {
  /** Literal chord, used only when `shortcutId` is absent. */
  keys?: string
  /** Catalog id whose live binding (incl. rebinds) supplies the keys. */
  shortcutId?: string
  description: string
}

const ESSENTIAL_ENTRIES: EssentialEntry[] = [
  { shortcutId: 'undoLastPageOp', description: 'keyboard.essential.undo' },
  { keys: '/', description: 'keyboard.essential.slash' },
  { keys: '[[', description: 'keyboard.essential.link' },
  { keys: '@', description: 'keyboard.essential.tag' },
  { shortcutId: 'findInPage', description: 'keyboard.essential.search' },
]

/** Resolve an Essential entry's display chord — live from the registry when
 * it references a catalog id, else its literal `keys`. */
function essentialKeys(entry: EssentialEntry): string {
  if (entry.shortcutId) return getShortcutKeys(entry.shortcutId)
  return entry.keys ?? ''
}

interface DeepLinkEntry {
  path: string
  description: string
}

// Mirrors the three hosts the Rust router (`src-tauri/src/deeplink/mod.rs`
// `parse_deep_link`) accepts. Keep in sync with that file — any new host
// added there must appear here so the help sheet stays accurate.
const DEEP_LINK_ENTRIES: DeepLinkEntry[] = [
  { path: 'agaric://block/<ULID>', description: 'keyboard.deepLinks.block' },
  { path: 'agaric://page/<ULID>', description: 'keyboard.deepLinks.page' },
  { path: 'agaric://settings/<tab>', description: 'keyboard.deepLinks.settings' },
]

interface SyntaxEntry {
  syntax: string
  description: string
}

const SYNTAX_ENTRIES: SyntaxEntry[] = [
  { syntax: '**text**', description: 'keyboard.syntax.bold' },
  { syntax: '*text*', description: 'keyboard.syntax.italic' },
  { syntax: '`text`', description: 'keyboard.syntax.inlineCode' },
  { syntax: '~~text~~', description: 'keyboard.syntax.strikethrough' },
  { syntax: '==text==', description: 'keyboard.syntax.highlight' },
  { syntax: '# Heading', description: 'keyboard.syntax.heading' },
  { syntax: '> quote', description: 'keyboard.syntax.blockquote' },
  { syntax: '```lang', description: 'keyboard.syntax.codeBlock' },
  { syntax: '- [ ] task', description: 'keyboard.syntax.todoCheckbox' },
  { syntax: '- [x] task', description: 'keyboard.syntax.doneCheckbox' },
  { syntax: '@tag', description: 'keyboard.syntax.tagReference' },
  { syntax: '[[page]]', description: 'keyboard.syntax.pageLink' },
  { syntax: '((block))', description: 'keyboard.syntax.blockReference' },
  { syntax: '/command', description: 'keyboard.syntax.slashCommand' },
  // #214 Phase 3 — previously undocumented inline-syntax triggers.
  { syntax: ':', description: 'keyboard.syntax.emoji' },
  { syntax: '::', description: 'keyboard.syntax.properties' },
  { syntax: '<u>', description: 'keyboard.syntax.underline' },
]

interface KeyboardShortcutsProps {
  /** Controlled open state — used by the sidebar button. */
  open?: boolean
  /** Callback when the sheet open state changes. */
  onOpenChange?: (open: boolean) => void
}

export function KeyboardShortcuts({
  open: controlledOpen,
  onOpenChange,
}: KeyboardShortcutsProps): React.ReactElement {
  const [internalOpen, setInternalOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const { t } = useTranslation()

  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuild from localStorage when sheet opens
  const shortcutGroups = useMemo(() => buildShortcutGroups(), [open])

  // UX-388: filter visible shortcuts by description, key text, or category.
  const filteredGroups = useMemo(() => {
    if (!filter.trim()) return shortcutGroups
    const needle = filter.toLowerCase()
    return shortcutGroups
      .map((group) => ({
        category: group.category,
        shortcuts: group.shortcuts.filter(
          (s) =>
            t(s.description).toLowerCase().includes(needle) ||
            s.keys.toLowerCase().includes(needle) ||
            t(group.category).toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.shortcuts.length > 0)
  }, [shortcutGroups, filter, t])

  const setOpen = useCallback(
    (value: boolean) => {
      if (isControlled) {
        onOpenChange?.(value)
      } else {
        setInternalOpen(value)
        onOpenChange?.(value)
      }
    },
    [isControlled, onOpenChange],
  )

  // The global `showShortcuts` keydown listener (default `?`) lives in
  // `useAppDialogs` (#754) — App.tsx gate-mounts this lazy sheet on
  // `shortcutsOpen`, so an in-sheet listener could never fire while the
  // sheet is closed (it would not be mounted). Keeping a copy here would
  // only add a redundant document listener while the sheet is open.

  // UX-228: close the sheet when the global "close all overlays" shortcut
  // fires (Escape by default). Radix already handles Escape when focus is
  // inside the sheet, but if focus has drifted elsewhere we still want the
  // sheet to dismiss.
  useEffect(() => {
    function handleClose() {
      setOpen(false)
    }
    window.addEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
    return () => window.removeEventListener(CLOSE_ALL_OVERLAYS_EVENT, handleClose)
  }, [setOpen])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" />
            {t('shortcuts.title')}
          </SheetTitle>
          <SheetDescription>{t('keyboard.sheetDescription')}</SheetDescription>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('keyboard.filterPlaceholder')}
            aria-label={t('keyboard.filterLabel')}
            className="mt-2"
            data-testid="shortcuts-filter"
          />
        </SheetHeader>
        <ScrollArea className="px-4 pb-4" data-testid="shortcuts-table">
          {/* #214 Phase 3 — "Essential" group: the five core triggers a new
              user needs first, surfaced above the full catalog-driven list. */}
          <table className="w-full text-sm" data-testid="essential-table">
            <thead>
              <tr>
                <th
                  colSpan={2}
                  className="pb-1 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  data-testid="essential-section-title"
                >
                  {t('keyboard.category.essential')}
                </th>
              </tr>
              <tr className="border-b">
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.shortcutHeader')}
                </th>
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.actionHeader')}
                </th>
              </tr>
            </thead>
            <tbody>
              {ESSENTIAL_ENTRIES.map((entry) => (
                <tr key={entry.description} className="border-b last:border-0">
                  <td className="py-3 pr-4">
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {renderKeys(essentialKeys(entry))}
                    </span>
                  </td>
                  <td className="py-3 text-muted-foreground">{t(entry.description)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-sm mt-6">
            <thead>
              <tr className="border-b">
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.shortcutHeader')}
                </th>
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.actionHeader')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredGroups.length === 0 && (
                <tr>
                  <td
                    colSpan={2}
                    className="py-6 text-center text-sm text-muted-foreground"
                    data-testid="shortcuts-filter-empty"
                  >
                    {t('keyboard.filterEmpty')}
                  </td>
                </tr>
              )}
              {filteredGroups.map((group) => (
                <React.Fragment key={group.category}>
                  <tr>
                    <td
                      colSpan={2}
                      className="sticky top-0 z-10 bg-background pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {t(group.category)}
                    </td>
                  </tr>
                  {group.shortcuts.map((shortcut) => (
                    <tr
                      key={`${shortcut.keys}-${shortcut.condition ?? ''}`}
                      className="border-b last:border-0"
                    >
                      <td className="py-3 pr-4">
                        <span className="inline-flex flex-wrap items-center gap-1">
                          {renderKeys(shortcut.keys)}
                          {shortcut.condition && (
                            <small className="text-xs text-muted-foreground font-normal">
                              {t(shortcut.condition)}
                            </small>
                          )}
                          {shortcut.isCustom && (
                            <Badge tone="secondary" className="ml-1 text-xs">
                              {t('keyboard.settings.customized')}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className="py-3 text-muted-foreground">{t(shortcut.description)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          <table className="w-full text-sm mt-6" data-testid="syntax-table">
            <thead>
              <tr className="border-b">
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('shortcuts.syntaxSection')}
                </th>
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.descriptionHeader')}
                </th>
              </tr>
            </thead>
            <tbody>
              {SYNTAX_ENTRIES.map((entry) => (
                <tr key={entry.syntax} className="border-b last:border-0">
                  <td className="py-3 pr-4">
                    <code className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {entry.syntax}
                    </code>
                  </td>
                  <td className="py-3 text-muted-foreground">{t(entry.description)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Deep links — `agaric://…` URLs the OS routes back into the app.
              Listed so power users discover the scheme without grepping
              the codebase. Hosts must mirror `parse_deep_link` in
              `src-tauri/src/deeplink/mod.rs`. */}
          <table className="w-full text-sm mt-6" data-testid="deep-links-table">
            <thead>
              <tr className="border-b">
                <th
                  colSpan={2}
                  className="pb-1 text-left font-semibold text-foreground"
                  data-testid="deep-links-section-title"
                >
                  {t('keyboard.section.deepLinks')}
                </th>
              </tr>
              <tr>
                <td colSpan={2} className="pb-2 text-xs text-muted-foreground">
                  {t('keyboard.deepLinks.description')}
                </td>
              </tr>
              <tr className="border-b">
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.deepLinks.pathHeader')}
                </th>
                <th className="pb-2 text-left font-semibold text-foreground">
                  {t('keyboard.deepLinks.actionHeader')}
                </th>
              </tr>
            </thead>
            <tbody>
              {DEEP_LINK_ENTRIES.map((entry) => (
                <tr key={entry.path} className="border-b last:border-0">
                  <td className="py-3 pr-4">
                    <code className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {entry.path}
                    </code>
                  </td>
                  <td className="py-3 text-muted-foreground">{t(entry.description)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
        {/* UX-260 sub-fix 7: footer link into Settings → Keyboard so users
            discover that shortcuts are customisable. */}
        <SheetFooter className="border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              try {
                window.localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, 'keyboard')
              } catch {
                // storage may be disabled (private mode etc.) — ignore
              }
              // #734 — ALSO write the store handoff slot SettingsView subscribes
              // to while mounted. The localStorage write above only lands on a
              // fresh mount; when Settings is already the current view it is
              // ignored, so without this the Keyboard tab never opens. Mirrors
              // the deep-link router / NoPeersDialog CTA.
              useNavigationStore.getState().setPendingSettingsTab('keyboard')
              useNavigationStore.getState().setView('settings')
            }}
            data-testid="keyboard-customize-button"
          >
            <SettingsIcon className="h-4 w-4" />
            {t('keyboard.customizeButton')}
            <ChevronRight className="h-3.5 w-3.5 ml-auto" aria-hidden="true" />
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
