/**
 * InlinePicker — shared building blocks for the toolbar's single-step, searchable
 * type/variant pickers (#3001).
 *
 * Before #3001 choosing a callout variant or a code-block language was a two-step
 * "primary click → reopen menu → secondary selection" flow: the Turn-into row first
 * converted the block to the *default* variant and closed the popover, and only on
 * a REOPEN did a secondary picker appear below the primary list. These primitives
 * collapse that into one interaction — a filter input + a keyboard-navigable list —
 * so the user picks the type AND variant in a single pass, by mouse or keyboard.
 *
 * Three pieces, deliberately headless-ish so each selector keeps ownership of its
 * data and its apply-selection command (callouts dispatch `INSERT_CALLOUT`; code
 * languages drive the tiptap chain / `toggleCodeBlockSafely`):
 *
 *  - `useInlinePickerKeyboard` — wires the filter input's key handling: Space stays
 *    a literal filter character, Escape closes, ArrowUp/Down move the highlight and
 *    Enter selects (delegated to `useListKeyboardNavigation`).
 *  - `PickerFilterInput` — the auto-focused filter box rendered at the top.
 *  - `PickerRow` — a ghost button row with the shared toolbar styling, an optional
 *    leading icon, and active / keyboard-focused highlight states.
 *
 * Rows use `onPointerDown + preventDefault` (not onClick) so focus stays in the
 * editor and the focus-keyed block command bus still targets the focused block —
 * mirroring every other toolbar popover trigger.
 */

import type React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { cn } from '@/lib/utils'

export interface UseInlinePickerKeyboardOptions {
  /** Number of keyboard-selectable rows currently rendered. */
  itemCount: number
  /** Apply the row at `index` (Enter on the filter input). */
  onSelect: (index: number) => void
  /** Close the picker (Escape on the filter input). */
  onClose: () => void
}

export interface UseInlinePickerKeyboardReturn {
  /** Index of the keyboard-highlighted row. */
  focusedIndex: number
  /** Attach to the filter input's `onKeyDown`. */
  handleFilterKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

/**
 * Keyboard wiring for an inline picker's filter input.
 *
 * Space is intentionally NOT treated as "select" — it must remain a literal
 * filter character (some labels/languages could contain it). Escape closes the
 * picker. Everything else (ArrowUp/Down, Enter) is delegated to the shared list
 * navigation hook; when it handles the key we `preventDefault` so the caret /
 * scroll doesn't also move.
 */
export function useInlinePickerKeyboard({
  itemCount,
  onSelect,
  onClose,
}: UseInlinePickerKeyboardOptions): UseInlinePickerKeyboardReturn {
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount,
    onSelect,
  })

  function handleFilterKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === ' ') return
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (handleKeyDown(e)) e.preventDefault()
  }

  return { focusedIndex, handleFilterKeyDown }
}

export interface PickerFilterInputProps {
  value: string
  onChange: (value: string) => void
  /** Accessible label; also the effective placeholder-less input name. */
  ariaLabel: string
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

/** Auto-focused filter box rendered at the top of an inline picker. */
export function PickerFilterInput({
  value,
  onChange,
  ariaLabel,
  onKeyDown,
}: PickerFilterInputProps): React.ReactElement {
  return (
    <Input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: the filter input lives inside a popover that only opens on user action, so typing filters immediately
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="mb-1"
      onKeyDown={onKeyDown}
    />
  )
}

export interface PickerRowProps {
  /** Visible label (also the accessible name via the wrapping span). */
  label: React.ReactNode
  /** Optional leading icon component. */
  icon?: React.ComponentType<{ className?: string | undefined }> | undefined
  /** Marks the row as the current value (persistent highlight). */
  active?: boolean | undefined
  /** Marks the row as the keyboard-highlighted row. */
  focused?: boolean | undefined
  /** Apply this row. */
  onSelect: () => void
  testId?: string | undefined
}

/** A ghost-button row in an inline picker. */
export function PickerRow({
  label,
  icon: Icon,
  active,
  focused,
  onSelect,
  testId,
}: PickerRowProps): React.ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={testId}
      className={cn(
        'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
        active && 'bg-accent',
        focused && 'bg-accent text-accent-foreground',
      )}
      onPointerDown={(e) => {
        e.preventDefault()
        onSelect()
      }}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0 mr-2" /> : null}
      <span>{label}</span>
    </Button>
  )
}
