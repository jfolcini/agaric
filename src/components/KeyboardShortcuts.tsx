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
import { useNavigationStore } from '@/stores/navigation'
import { getCurrentShortcuts } from '../lib/keyboard-config'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../lib/overlay-events'
import { renderKeys } from '../lib/render-keyboard-shortcut'

interface ShortcutDef {
  keys: string
  condition?: string
  description: string
  isCustom?: boolean
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
  return Array.from(groupMap.entries()).map(([category, shortcuts]) => ({ category, shortcuts }))
}

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild from localStorage when sheet opens
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

  // Global `?` key listener — opens the sheet when no input is focused
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== '?') return

      const target = e.target as HTMLElement | null
      if (!target) return

      // Don't open when typing in an input, textarea, or contenteditable
      const tagName = target.tagName?.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea') return
      if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return

      e.preventDefault()
      setOpen(true)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setOpen])

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
          <table className="w-full text-sm">
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
                            <Badge variant="secondary" className="ml-1 text-xs">
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
                window.localStorage.setItem('agaric-settings-active-tab', 'keyboard')
              } catch {
                // storage may be disabled (private mode etc.) — ignore
              }
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
