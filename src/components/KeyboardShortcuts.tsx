/**
 * KeyboardShortcuts — help panel showing all available keyboard shortcuts (UX #9).
 *
 * Triggered by pressing `?` globally (when not editing a block) or via
 * a sidebar button. Uses the Sheet component for a slide-in panel.
 */

import { Keyboard } from 'lucide-react'
import React, { useCallback, useEffect, useState } from 'react'
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
    category: 'Navigation',
    shortcuts: [
      { keys: 'Arrow Up / Left', condition: 'at start', description: 'Move to previous block' },
      { keys: 'Arrow Down / Right', condition: 'at end', description: 'Move to next block' },
    ],
  },
  {
    category: 'Editing',
    shortcuts: [
      { keys: 'Enter', description: 'Save block and close editor' },
      { keys: 'Backspace', condition: 'on empty block', description: 'Delete block' },
      { keys: 'Backspace', condition: 'at start of block', description: 'Merge with previous' },
      { keys: 'Tab', description: 'Indent block' },
      { keys: 'Shift + Tab', description: 'Dedent block' },
      {
        keys: 'Ctrl + Enter',
        description: 'Cycle task state (TODO → DOING → DONE → none)',
      },
    ],
  },
  {
    category: 'Pickers',
    shortcuts: [
      { keys: '#', condition: 'in editor', description: 'Tag picker' },
      { keys: '[[', condition: 'in editor', description: 'Block link picker' },
    ],
  },
  {
    category: 'Journal',
    shortcuts: [
      { keys: 'Alt + ←', description: 'Previous day / week / month' },
      { keys: 'Alt + →', description: 'Next day / week / month' },
      { keys: 'Alt + T', description: 'Go to today' },
    ],
  },
  {
    category: 'UI',
    shortcuts: [
      { keys: '?', description: 'Show keyboard shortcuts' },
      { keys: 'Escape', description: 'Close dialog / cancel editing' },
    ],
  },
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
            Keyboard Shortcuts
          </SheetTitle>
          <SheetDescription id="shortcuts-description">
            Available keyboard shortcuts for the editor.
          </SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto px-4 pb-4" data-testid="shortcuts-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="pb-2 text-left font-semibold text-foreground">Shortcut</th>
                <th className="pb-2 text-left font-semibold text-foreground">Action</th>
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
                      {group.category}
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
                            <span className="text-xs text-muted-foreground font-normal">
                              {shortcut.condition}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-3 text-muted-foreground">{shortcut.description}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </SheetContent>
    </Sheet>
  )
}
