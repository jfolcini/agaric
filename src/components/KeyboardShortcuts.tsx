/**
 * KeyboardShortcuts — help panel showing all available keyboard shortcuts (UX #9).
 *
 * Triggered by pressing `?` globally (when not editing a block) or via
 * a sidebar button. Uses the Sheet component for a slide-in panel.
 */

import { Keyboard } from 'lucide-react'
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

interface ShortcutDef {
  keys: string
  condition?: string
  description: string
}

const SHORTCUT_GROUPS: { category: string; shortcuts: ShortcutDef[] }[] = [
  {
    category: 'keyboard.category.navigation',
    shortcuts: [
      {
        keys: 'Arrow Up / Left',
        condition: 'keyboard.condition.atStart',
        description: 'keyboard.moveToPreviousBlock',
      },
      {
        keys: 'Arrow Down / Right',
        condition: 'keyboard.condition.atEnd',
        description: 'keyboard.moveToNextBlock',
      },
    ],
  },
  {
    category: 'keyboard.category.editing',
    shortcuts: [
      { keys: 'Enter', description: 'keyboard.saveBlockAndClose' },
      {
        keys: 'Backspace',
        condition: 'keyboard.condition.onEmptyBlock',
        description: 'keyboard.deleteBlock',
      },
      {
        keys: 'Backspace',
        condition: 'keyboard.condition.atStartOfBlock',
        description: 'keyboard.mergeWithPrevious',
      },
      { keys: 'Ctrl + Shift + Arrow Right', description: 'keyboard.indentBlock' },
      { keys: 'Ctrl + Shift + Arrow Left', description: 'keyboard.dedentBlock' },
      {
        keys: 'Ctrl + Enter',
        description: 'keyboard.cycleTaskState',
      },
      { keys: 'Ctrl + .', description: 'keyboard.collapseExpandChildren' },
      { keys: 'Ctrl + K', description: 'keyboard.insertOrEditLink' },
      {
        keys: 'Ctrl + Shift + C',
        condition: 'keyboard.condition.inEditor',
        description: 'keyboard.toggleCodeBlock',
      },
      {
        keys: 'Ctrl + Shift + S',
        condition: 'keyboard.condition.inEditor',
        description: 'keyboard.toggleStrikethrough',
      },
      {
        keys: 'Ctrl + Shift + H',
        condition: 'keyboard.condition.inEditor',
        description: 'keyboard.toggleHighlight',
      },
      { keys: 'Ctrl + Shift + Arrow Up', description: 'keyboard.moveBlockUp' },
      { keys: 'Ctrl + Shift + Arrow Down', description: 'keyboard.moveBlockDown' },
      {
        keys: 'Shift + Enter',
        condition: 'keyboard.condition.inEditor',
        description: 'keyboard.insertLineBreak',
      },
    ],
  },
  {
    category: 'keyboard.category.pickers',
    shortcuts: [
      { keys: '@', condition: 'keyboard.condition.inEditor', description: 'keyboard.tagPicker' },
      {
        keys: '[[',
        condition: 'keyboard.condition.inEditor',
        description: 'keyboard.blockLinkPicker',
      },
      {
        keys: '/',
        condition: 'keyboard.condition.inEditor',
        description: 'keyboard.slashCommandMenu',
      },
    ],
  },
  {
    category: 'keyboard.category.journal',
    shortcuts: [
      { keys: 'Alt + ←', description: 'keyboard.previousDayWeekMonth' },
      { keys: 'Alt + →', description: 'keyboard.nextDayWeekMonth' },
      { keys: 'Alt + T', description: 'keyboard.goToToday' },
    ],
  },
  {
    category: 'keyboard.category.blockSelection',
    shortcuts: [
      { keys: 'Ctrl + Click', description: 'keyboard.toggleBlockSelection' },
      { keys: 'Shift + Click', description: 'keyboard.rangeSelectBlocks' },
      {
        keys: 'Ctrl + A',
        condition: 'keyboard.condition.notEditing',
        description: 'keyboard.selectAllBlocks',
      },
      {
        keys: 'Escape',
        condition: 'keyboard.condition.withSelection',
        description: 'keyboard.clearSelection',
      },
    ],
  },
  {
    category: 'keyboard.category.undoRedo',
    shortcuts: [
      {
        keys: 'Ctrl + Z',
        condition: 'keyboard.condition.outsideEditor',
        description: 'keyboard.undoLastPageOp',
      },
      {
        keys: 'Ctrl + Y',
        condition: 'keyboard.condition.outsideEditor',
        description: 'keyboard.redoLastUndoneOp',
      },
    ],
  },
  {
    category: 'keyboard.category.historyView',
    shortcuts: [
      { keys: 'Space', description: 'keyboard.toggleSelection' },
      { keys: 'Shift + Click', description: 'keyboard.rangeSelect' },
      { keys: 'Ctrl + A', description: 'keyboard.selectAll' },
      { keys: 'Enter', description: 'keyboard.revertSelected' },
      { keys: 'Escape', description: 'keyboard.clearSelection' },
      { keys: 'Arrow Up / Arrow Down', description: 'keyboard.navigateItems' },
      { keys: 'j / k', description: 'keyboard.navigateItemsVim' },
    ],
  },
  {
    category: 'keyboard.category.global',
    shortcuts: [
      { keys: 'Ctrl + F', description: 'keyboard.focusSearch' },
      { keys: 'Ctrl + B', description: 'keyboard.toggleSidebar' },
      { keys: 'Ctrl + N', description: 'keyboard.createNewPage' },
      { keys: '?', description: 'keyboard.showKeyboardShortcuts' },
      { keys: 'Escape', description: 'keyboard.closeOverlays' },
    ],
  },
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
  { syntax: '/command', description: 'keyboard.syntax.slashCommand' },
]

/** Render a keys string as styled <kbd> elements. Handles `+` combos and `/` alternatives. */
function renderKeys(keys: string): React.ReactNode {
  const alternatives = keys.split(' / ')
  return alternatives.map((alt, i) => {
    const parts = alt.split(' + ')
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

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" aria-describedby="shortcuts-description">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" />
            {t('shortcuts.title')}
          </SheetTitle>
          <SheetDescription id="shortcuts-description">
            {t('keyboard.sheetDescription')}
          </SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto overflow-x-auto px-4 pb-4" data-testid="shortcuts-table">
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
              {SHORTCUT_GROUPS.map((group) => (
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
        </div>
      </SheetContent>
    </Sheet>
  )
}
