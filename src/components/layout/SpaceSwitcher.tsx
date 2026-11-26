/**
 * SpaceSwitcher — sidebar-top space selector (Phase 1 + Phase 6).
 *
 * Renders a Radix Select bound to `useSpaceStore`. Changing the selection
 * updates `currentSpaceId` synchronously; downstream panels (PageBrowser,
 * SearchPanel, …) re-scope their queries when `currentSpaceId` flips.
 *
 * The `t('space.manage')` entry opens Settings › Spaces (#5362). The
 * MANAGE_SENTINEL value is short-circuited inside `handleValueChange`
 * so selecting it does not switch space.
 *
 * On a phone (`usePhoneLayout`) the list is a bottom-sheet menu (`MenuSheet`),
 * as the other menus there are, with the same rows.
 */

import { ChevronDown, Plus } from 'lucide-react'
import { type ComponentProps, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { MenuSheet } from '@/components/ui/menu-sheet'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useKeyboardHints } from '@/hooks/useKeyboardHints'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import type { SpaceRow } from '@/lib/bindings'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { accentVar } from '@/lib/space-accent'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'
import { DEFAULT_ACCENT_TOKEN, useSpaceStore } from '@/stores/space'

/**
 * Sentinel value used by the `t('space.manage')` item so Radix Select
 * does not treat the click as a real space switch. `SelectItem`
 * requires a non-empty `value`, so a unique reserved string is the
 * simplest way to keep the option in the listbox; `handleValueChange`
 * then short-circuits the sentinel and opens Settings › Spaces
 * instead of calling `setCurrentSpace`.
 */
const MANAGE_SENTINEL = '__manage__'

/**
 * Sentinel value for the single-space "Create another space" hint. Like
 * MANAGE_SENTINEL it is short-circuited in `handleValueChange` (opens
 * Settings › Spaces, does not switch space). Rendering the hint as a real
 * SelectItem — rather than a bare `<button>` inside SelectContent — keeps it
 * in Radix Select's roving-focus/type-ahead model so keyboard users can reach
 * it (#2281).
 */
const CREATE_SENTINEL = '__create__'

/**
 * Only the first nine spaces get a digit hotkey hint
 * (`switchSpace1` … `switchSpace9`). Tenth-and-later spaces
 * still render as selectable rows; they just don't carry a chip because
 * there is no shortcut bound to them.
 */
const MAX_HOTKEY_SPACES = 9

/** The Nth space's `switchSpaceN` binding (`Alt + 1`). */
function spaceHotkey(index: number): string {
  return getShortcutKeys(`switchSpace${index + 1}`)
}

/** A space's colour, as `SpaceTopStripe` paints it once the space is current. */
function SpaceDot({ space, ...props }: { space: SpaceRow } & ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      // An unset accent is the default, not `--accent-current`: that is the
      // active space's colour, wrong on any other space's row.
      style={{ backgroundColor: accentVar(space.accent_color || DEFAULT_ACCENT_TOKEN) }}
      {...props}
    />
  )
}

interface SpaceSwitcherProps {
  /** Runs after an item has taken the user to Settings › Spaces. */
  onNavigate?: () => void
}

export function SpaceSwitcher({ onNavigate }: SpaceSwitcherProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace)
  const keyboardHints = useKeyboardHints()
  const phoneLayout = usePhoneLayout()
  const [sheetOpen, setSheetOpen] = useState(false)

  // Colour identity in the trigger. The dot inherits the
  // active space's accent so the user reads the same colour signal
  // here that `SpaceTopStripe` paints across the top of the viewport.
  const activeSpace = availableSpaces.find((s) => s.id === currentSpaceId)

  const handleValueChange = (next: string) => {
    if (next === MANAGE_SENTINEL || next === CREATE_SENTINEL) {
      const navigation = useNavigationStore.getState()
      navigation.setPendingSettingsTab('spaces')
      navigation.setView('settings')
      onNavigate?.()
      return
    }
    setCurrentSpace(next)
  }

  const accentDot = activeSpace != null && (
    <SpaceDot space={activeSpace} data-testid="space-switcher-accent-dot" />
  )

  if (phoneLayout) {
    const pick = (value: string) => {
      setSheetOpen(false)
      handleValueChange(value)
    }
    return (
      <MenuSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={t('space.switch')}
        trigger={
          <SheetTrigger asChild>
            <Button
              variant="outline"
              aria-label={t('space.switch')}
              className="w-full justify-start px-3 text-sm font-medium"
            >
              {accentDot}
              <span className="min-w-0 flex-1 truncate text-start">
                {activeSpace?.name ?? t('space.switch')}
              </span>
              <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
            </Button>
          </SheetTrigger>
        }
      >
        <div className="flex flex-col gap-0.5">
          {availableSpaces.map((space) => (
            <PopoverMenuItem
              key={space.id}
              className="flex items-center gap-2"
              active={space.id === currentSpaceId}
              aria-current={space.id === currentSpaceId ? 'true' : undefined}
              onClick={() => pick(space.id)}
            >
              <SpaceDot space={space} data-testid="space-option-dot" />
              {space.name}
            </PopoverMenuItem>
          ))}
          <hr className="my-1 h-px border-0 bg-border" />
          {availableSpaces.length === 1 && (
            <PopoverMenuItem
              className="text-muted-foreground"
              data-testid="single-space-create-hint"
              onClick={() => pick(CREATE_SENTINEL)}
            >
              <Plus aria-hidden="true" />
              {t('spaceSwitcher.createAnotherHint')}
            </PopoverMenuItem>
          )}
          <PopoverMenuItem className="text-muted-foreground" onClick={() => pick(MANAGE_SENTINEL)}>
            {t('space.manage')}
          </PopoverMenuItem>
        </div>
      </MenuSheet>
    )
  }

  return (
    <Select value={currentSpaceId ?? ''} onValueChange={handleValueChange}>
      {/*
       * Surface the `Alt+1..9` space-switching
       * shortcuts via a tooltip on the trigger so users discover
       * them without opening the `?` keyboard help dialog; only where
       * there is a keyboard to press them (`useKeyboardHints`). The
       * tooltip wraps a `<span>` rather than the SelectTrigger
       * directly so the Tooltip's pointer events do not interfere
       * with Radix Select's own trigger handling, and the tooltip
       * still surfaces over disabled / non-button anchors.
       */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block w-full">
            <SelectTrigger
              aria-label={t('space.switch')}
              className={cn(
                'w-full *:data-[slot=select-value]:flex-1',
                // Inherit the sidebar's tight typography while preserving
                // the 44px touch target via the Select's built-in
                // `[@media(pointer:coarse)]:h-11` rule.
                'text-sm font-medium',
              )}
            >
              {/*
               * Replace the previous static "Space:" text
               * Prefix with a colour-identity dot that
               * mirrors `SpaceTopStripe` and `SpaceAccentBadge`. The
               * dot is decorative (`aria-hidden`) so the
               * `aria-label={t('space.switch')}` on `SelectTrigger` is
               * still the accessible name. Rendered as a sibling
               * BEFORE `<SelectValue>` for the same reason the old
               * prefix span was: Radix mirrors the active option's
               * text into `SelectValue` and wrapping it would trip
               * The auto-mirror warning called out in the
               * comment below.
               */}
              {accentDot}
              {/*
               * Keep the digit-hint chip scoped to the
               * dropdown rows so it does not bleed into the trigger
               * label. Implemented via the `endContent` slot on
               * `SelectItem` (rendered AFTER `<SelectPrimitive.ItemText>`,
               * outside the auto-mirror surface) — see the prop's
               * docstring in `ui/select.tsx` for why we cannot pass
               * children to `SelectValue` here without tripping React
               * 19's portal/ref-children-conflict warning.
               */}
              <SelectValue placeholder={t('space.switch')} />
            </SelectTrigger>
          </span>
        </TooltipTrigger>
        {/*
         * Stack the existing shortcut hint above a list of
         * the first five space → digit mappings so the user can see
         * what each `Alt+1..5` chord switches to without
         * re-opening the dropdown. The dropdown rows still carry the
         * digit-hint chip via `SelectItem`'s `endContent` slot — that
         * Is contribution and is kept untouched.
         */}
        {keyboardHints && (
          <TooltipContent>
            <div className="flex flex-col gap-0.5 text-xs">
              <span>{t('spaceSwitcher.shortcutHint')}</span>
              {availableSpaces.slice(0, 5).map((space, idx) => (
                <span key={space.id} className="opacity-90">
                  <Kbd keys={spaceHotkey(idx)} /> {space.name}
                </span>
              ))}
            </div>
          </TooltipContent>
        )}
      </Tooltip>
      <SelectContent>
        {availableSpaces.map((space, idx) => (
          <SelectItem
            key={space.id}
            value={space.id}
            startContent={<SpaceDot space={space} data-testid="space-option-dot" />}
            endContent={
              idx < MAX_HOTKEY_SPACES && keyboardHints ? (
                /*
                 * Right-aligned digit-hint chip (`Alt+1`) for the
                 * first nine spaces. Rendered via
                 * `SelectItem`'s `endContent` slot so it stays out of
                 * `<SelectPrimitive.ItemText>` and therefore out of
                 * Radix's auto-mirror into the trigger label.
                 */
                <Kbd
                  keys={spaceHotkey(idx)}
                  aria-hidden="true"
                  className="ml-auto"
                  data-testid={`space-hotkey-hint-${idx + 1}`}
                />
              ) : undefined
            }
          >
            {space.name}
          </SelectItem>
        ))}
        <SelectSeparator />
        {/*
         * When the user has only one space, the switcher is
         * a visual no-op (nothing else to switch to). Surface a
         * `t('spaceSwitcher.createAnotherHint')` hint inside the dropdown so the
         * single-space user discovers the manage flow without having
         * to scan past the (lone) space row to the `t('space.manage')`
         * entry below. Rendered as a real `<SelectItem>` (CREATE_SENTINEL)
         * so it joins Radix Select's roving-focus/type-ahead model and is
         * keyboard-reachable (#2281); `handleValueChange` short-circuits the
         * sentinel and opens Settings › Spaces, as the MANAGE_SENTINEL
         * route does, so selecting it does not switch space.
         */}
        {availableSpaces.length === 1 ? (
          <SelectItem
            value={CREATE_SENTINEL}
            className="text-muted-foreground"
            data-testid="single-space-create-hint"
          >
            <span className="flex items-center gap-2">
              <Plus aria-hidden="true" />
              {t('spaceSwitcher.createAnotherHint')}
            </span>
          </SelectItem>
        ) : null}
        {/*
         * The `t('space.manage')` entry. `handleValueChange`
         * short-circuits the sentinel and opens Settings › Spaces
         * instead of calling `setCurrentSpace`, so selecting it does not
         * switch space.
         */}
        <SelectItem value={MANAGE_SENTINEL} className="text-muted-foreground">
          {t('space.manage')}
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
