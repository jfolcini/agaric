/**
 * Shared primitives for the `FormattingToolbar` decomposition (MAINT-219).
 *
 * Extracted from the orchestrator so each per-group renderer file can
 * lean on the same `Tip` wrapper, render-mode union, and config-driven
 * button renderer without re-exporting types through the orchestrator.
 *
 * Nothing in here owns state; all functions are pure given their args.
 */

import type React from 'react'

import { getShortcutKeys } from '@/lib/keyboard-config'
import type { ToolbarButtonConfig } from '@/lib/toolbar-config'
import { toolbarActiveClass } from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/** Render mode for each toolbar item. */
export type RenderMode = 'inline' | 'overflow' | 'sentinel'

/**
 * Map of toolbar button label keys to keyboard-config shortcut ids (UX-301).
 * Buttons listed here get their tooltip rebuilt as `${label} (${binding})`
 * via `tooltipWithShortcut`, picking up any user customisation. Buttons
 * absent from this map keep their existing `tip` i18n string.
 */
export const TOOLBAR_SHORTCUT_IDS: Record<string, string> = {
  // Mirror SelectionBubbleMenu's BUBBLE_MENU_SHORTCUT_IDS exactly: the same
  // mark actions resolve their chord from the rebindable catalog, so the tip
  // tracks user customisation instead of a frozen i18n string. Bold/Italic are
  // intentionally absent — they use TipTap StarterKit defaults and are not in
  // the configurable catalog (matching the bubble menu).
  'toolbar.code': 'inlineCode',
  'toolbar.strikethrough': 'strikethrough',
  'toolbar.highlight': 'highlight',
}

/**
 * Append the current keyboard binding for `shortcutId` to `label` so the
 * tooltip stays in sync with user customisations (UX-301). Returns the
 * plain label when the id is unknown so we never render an empty `()`
 * for buttons that lack a configurable shortcut.
 */
export function tooltipWithShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

export const Tip = ({
  ref,
  label,
  children,
}: {
  label: string
  children: React.ReactElement
  ref?: React.Ref<HTMLButtonElement>
}) => (
  // #1094: the formatting toolbar deliberately uses a 200ms hover delay
  // (snappier than the 300ms app baseline) — the toolbar is a dense strip of
  // icon buttons sitting right at the edit point, so its tips should appear
  // quickly. This `Tip` is used only by the FormattingToolbar family, all of
  // which shared the old per-surface `<TooltipProvider delayDuration={200}>`;
  // the override now lives on the Tooltip itself so it stays explicit instead
  // of silently inheriting the app-level default once that provider is gone.
  <Tooltip delayDuration={200}>
    <TooltipTrigger asChild ref={ref}>
      {children}
    </TooltipTrigger>
    <TooltipContent side="bottom" sideOffset={6}>
      {label}
    </TooltipContent>
  </Tooltip>
)
Tip.displayName = 'Tip'

/**
 * Render a config-driven button. In `inline` and `sentinel` modes the
 * button is icon-only (matches the existing toolbar). In `overflow`
 * mode the button widens into a list row with icon + label, matching
 * `HeadingLevelSelector` / `CodeLanguageSelector` so the 44 px touch
 * floor is honoured.
 */
export function renderConfigButton(
  btn: ToolbarButtonConfig,
  state: Record<string, unknown>,
  mode: RenderMode,
  t: (key: string) => string,
  onAfterAction?: () => void,
): React.ReactElement {
  const shortcutId = TOOLBAR_SHORTCUT_IDS[btn.label]
  const tooltip = shortcutId ? tooltipWithShortcut(t(btn.label), shortcutId) : t(btn.tip)
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
        className={cn(
          'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
          isActive && toolbarActiveClass,
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          btn.action()
          onAfterAction?.()
        }}
      >
        <btn.icon className="h-3.5 w-3.5 mr-2" />
        <span>{t(btn.label)}</span>
      </Button>
    )
  }

  return (
    <Tip label={tooltip}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t(btn.label)}
        aria-pressed={btn.activeKey ? isActive : undefined}
        disabled={disabled}
        className={cn(isActive && toolbarActiveClass)}
        onPointerDown={(e) => {
          e.preventDefault()
          btn.action()
        }}
      >
        <btn.icon className="h-3.5 w-3.5" />
      </Button>
    </Tip>
  )
}
