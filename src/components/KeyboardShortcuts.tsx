/**
 * KeyboardShortcuts — help panel showing all available keyboard shortcuts (UX #9).
 *
 * Triggered by pressing `?` globally (when not editing a block) or via
 * a sidebar button. Uses the Sheet component for a slide-in panel.
 */

import { Keyboard } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getCurrentShortcuts } from '../lib/keyboard-config'
import { CLOSE_ALL_OVERLAYS_EVENT } from '../lib/overlay-events'
import { modKey } from '../lib/platform'

interface ShortcutDef {
  keys: string
  condition?: string
  description: string
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
  { syntax: '/command', description: 'keyboard.syntax.slashCommand' },
]

/** Render a keys string as styled <kbd> elements. Handles `+` combos and `/` alternatives. */
function renderKeys(keys: string): React.ReactNode {
  const alternatives = keys.split(' / ')
  const mod = modKey()
  return alternatives.map((alt, i) => {
    const parts = alt.split(' + ').map((part) => (part === 'Ctrl' ? mod : part))
    return (
      <React.Fragment key={alt}>
        {i > 0 && <span className="text-muted-foreground font-normal mx-1">/</span>}
        {parts.map((part, j) => (
          <React.Fragment key={part}>
            {j > 0 && <span className="text-muted-foreground font-normal mx-0.5">+</span>}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold shadow-sm">
              {part}
            </kbd>
          </React.Fragment>
        ))}
      </React.Fragment>
    )
  })
}

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
  const { t } = useTranslation()

  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild from localStorage when sheet opens
  const shortcutGroups = useMemo(() => buildShortcutGroups(), [open])

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
              {shortcutGroups.map((group) => (
                <React.Fragment key={group.category}>
                  <tr>
                    <td
                      colSpan={2}
                      className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
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
      </SheetContent>
    </Sheet>
  )
}
