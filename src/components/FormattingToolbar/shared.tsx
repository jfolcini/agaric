/**
 * Shared primitives for the `FormattingToolbar` decomposition.
 *
 * Extracted from the orchestrator so each per-group renderer file can
 * lean on the same shortcut lookup, render-mode union, and config-driven
 * button renderer without re-exporting types through the orchestrator.
 *
 * Nothing in here owns state; all functions are pure given their args.
 */

import type React from 'react'

import type { ToolbarButtonConfig } from '@/components/FormattingToolbar/toolbar-config'
import {
  MARK_TOGGLE_SHORTCUT_IDS,
  toolbarActiveClass,
  toolbarMenuRowClass,
} from '@/components/FormattingToolbar/toolbar-config'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { cn } from '@/lib/utils'

/** Render mode for each toolbar item. */
export type RenderMode = 'inline' | 'overflow' | 'sentinel'

/**
 * Toolbar button label key → keyboard-config shortcut id. The button's
 * tooltip shows the binding the catalog holds now, so it follows a user's
 * rebinding; a button absent here shows its name alone.
 */
export const TOOLBAR_SHORTCUT_IDS: Record<string, string> = {
  ...MARK_TOGGLE_SHORTCUT_IDS,
  'toolbar.newLine': 'insertLineBreak',
  'toolbar.insertDate': 'openDatePicker',
  'toolbar.todoToggle': 'cycleTaskState',
  'toolbar.properties': 'openPropertiesDrawer',
  'toolbar.undo': 'undoLastPageOp',
  'toolbar.redo': 'redoLastUndoneOp',
}

/** `IconButton`'s `shortcut` for a toolbar button: its current binding, or none. */
export function toolbarShortcut(label: string): { shortcut?: string } {
  const id = TOOLBAR_SHORTCUT_IDS[label]
  const keys = id ? getShortcutKeys(id) : ''
  return keys ? { shortcut: keys } : {}
}

/**
 * Pointer + keyboard activation handlers for toolbar/menu buttons. Every
 * primary press is `preventDefault`ed on `pointerdown`, so the editor keeps its
 * focus and selection through it; right/middle click stay inert.
 *
 * - A mouse acts on `pointerdown`.
 * - A finger acts on its release, through the click the browser sends after it,
 *   unless the press showed the button's name:
 *   an `IconButton` held past the long-press delay opens its tooltip, which
 *   Radix marks on the trigger (`data-state="…-open"`), and that release does
 *   nothing, so learning a name never applies it (#6895). A control with no
 *   name to show acts however long the press. A press the browser takes for a
 *   scroll is cancelled and does nothing.
 * - The `click` fallback acts only for keyboard-generated clicks (Enter/Space
 *   dispatch one with `detail === 0`) and a finger's release, so a pointer press
 *   never double-fires.
 *
 * A finger acts on the release's click rather than the release itself: acting
 * on the release put the action's result (Block actions' sheet, Delete at its
 * foot) under the finger before that click landed, which then hit it (#7040).
 */
/** Buttons a finger has lifted from, waiting for that release's click. */
const fingerLifted = new WeakSet<HTMLButtonElement>()

export function toolbarPressHandlers(
  action: (button: HTMLButtonElement) => void,
): Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onPointerDown' | 'onPointerUp' | 'onClick'
> {
  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      fingerLifted.delete(e.currentTarget)
      if (e.pointerType !== 'touch') action(e.currentTarget)
    },
    onPointerUp: (e) => {
      if (e.pointerType !== 'touch') return
      if (e.currentTarget.dataset['state']?.endsWith('open')) return
      fingerLifted.add(e.currentTarget)
    },
    onClick: (e) => {
      if (e.detail === 0 || fingerLifted.delete(e.currentTarget)) action(e.currentTarget)
    },
  }
}

/**
 * Render a config-driven button. In `inline` and `sentinel` modes the
 * button is icon-only (matches the existing toolbar). In `overflow`
 * mode the button widens into a list row with icon + label, matching
 * `CodeLanguageSelector` so the 44 px touch floor is honoured.
 */
export function renderConfigButton(
  btn: ToolbarButtonConfig,
  state: Record<string, unknown>,
  mode: RenderMode,
  t: (key: string) => string,
  onAfterAction?: () => void,
): React.ReactElement {
  const isActive = btn.activeKey ? (state[btn.activeKey] as boolean) : false
  const disabled = btn.disabledWhenFalse ? !state[btn.disabledWhenFalse] : undefined

  if (mode === 'overflow') {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t(btn.label)}
        aria-pressed={btn.activeKey ? isActive : undefined}
        disabled={disabled}
        className={cn(toolbarMenuRowClass, isActive && toolbarActiveClass)}
        {...toolbarPressHandlers(() => {
          btn.action()
          onAfterAction?.()
        })}
      >
        <btn.icon className="mr-2" />
        <span>{t(btn.label)}</span>
      </Button>
    )
  }

  const common = {
    variant: 'ghost',
    size: 'icon-xs',
    'aria-pressed': btn.activeKey ? isActive : undefined,
    disabled,
    className: cn(isActive && toolbarActiveClass),
    ...toolbarPressHandlers(btn.action),
  } as const
  // The sentinel is only measured, and a tooltip adds no width.
  if (mode === 'sentinel') {
    return (
      <Button {...common} aria-label={t(btn.label)}>
        <btn.icon />
      </Button>
    )
  }
  return (
    <IconButton
      {...common}
      tooltip={t(btn.tip)}
      ariaLabel={t(btn.label)}
      {...toolbarShortcut(btn.label)}
    >
      <btn.icon />
    </IconButton>
  )
}
