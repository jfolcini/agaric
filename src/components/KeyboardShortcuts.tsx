/**
 * KeyboardShortcuts — help panel showing all available keyboard shortcuts (UX #9).
 *
 * Triggered by pressing `?` globally (when not editing a block) or via
 * a sidebar button. Uses the Sheet component for a slide-in panel.
 */

import { Keyboard } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: 'Arrow Up / Left at start', description: 'Move to previous block' },
  { keys: 'Arrow Down / Right at end', description: 'Move to next block' },
  { keys: 'Backspace on empty block', description: 'Delete block' },
  { keys: 'Backspace at start of block', description: 'Merge with previous' },
  { keys: 'Tab', description: 'Indent block' },
  { keys: 'Shift + Tab', description: 'Dedent block' },
  { keys: '# in editor', description: 'Tag picker' },
  { keys: '[[ in editor', description: 'Block link picker' },
  { keys: '?', description: 'Show keyboard shortcuts' },
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
        <div className="px-4 pb-4" data-testid="shortcuts-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="pb-2 text-left font-medium text-muted-foreground">Shortcut</th>
                <th className="pb-2 text-left font-medium text-muted-foreground">Action</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.keys} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {shortcut.keys}
                    </kbd>
                  </td>
                  <td className="py-2 text-muted-foreground">{shortcut.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SheetContent>
    </Sheet>
  )
}
