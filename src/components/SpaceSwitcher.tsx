/**
 * SpaceSwitcher — sidebar-top space selector (FEAT-3 Phase 1 + Phase 6).
 *
 * Renders a Radix Select bound to `useSpaceStore`. Changing the selection
 * updates `currentSpaceId` synchronously; downstream panels (PageBrowser,
 * SearchPanel, …) re-scope their queries when `currentSpaceId` flips.
 *
 * The "Manage spaces…" entry now (FEAT-3 Phase 6) opens
 * `SpaceManageDialog` instead of being a disabled placeholder. The
 * MANAGE_SENTINEL value is short-circuited inside `handleValueChange`
 * so selecting it does not switch space — it only flips the dialog
 * open.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'
import { SpaceManageDialog } from './SpaceManageDialog'

/**
 * Sentinel value used by the "Manage spaces…" item so Radix Select
 * does not treat the click as a real space switch. `SelectItem`
 * requires a non-empty `value`, so a unique reserved string is the
 * simplest way to keep the option in the listbox; `handleValueChange`
 * then short-circuits the sentinel and opens the manage dialog
 * instead of calling `setCurrentSpace`.
 */
const MANAGE_SENTINEL = '__manage__'

/**
 * FEAT-3p11 — only the first nine spaces get a digit hotkey hint
 * (`Ctrl+1` … `Ctrl+9` / `⌘1` … `⌘9` on macOS). Tenth-and-later spaces
 * still render as selectable rows; they just don't carry a chip because
 * there is no shortcut bound to them.
 */
const MAX_HOTKEY_SPACES = 9

/**
 * FEAT-3p11 — render the platform-correct hint chip text. macOS users
 * see the bare command-glyph chord (`⌘1`) per Apple's HIG; Windows /
 * Linux users see the spelled-out modifier (`Ctrl+1`) that matches the
 * rest of the app's keyboard help. The display string is decoupled
 * from the underlying binding (which always stores `Ctrl + N` and
 * matches both `ctrlKey` and `metaKey` via `matchesShortcutBinding`),
 * so re-using it across platforms is safe.
 */
function spaceHotkeyHint(index: number): string {
  return isMac() ? `\u2318${index + 1}` : `Ctrl+${index + 1}`
}

export function SpaceSwitcher(): React.JSX.Element {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace)
  const refreshAvailableSpaces = useSpaceStore((s) => s.refreshAvailableSpaces)

  useEffect(() => {
    // Fire-and-forget refresh on mount. `refreshAvailableSpaces` never
    // rejects — internal errors are logged and `isReady` is still
    // flipped so the UI does not freeze.
    void refreshAvailableSpaces()
  }, [refreshAvailableSpaces])

  // FEAT-3 Phase 6 — local dialog open state. Hoisting this above the
  // store keeps the manage UI a pure component-local concern; the
  // Zustand store stays focused on `currentSpaceId` + cached
  // `availableSpaces`.
  const [manageOpen, setManageOpen] = useState(false)

  const handleValueChange = (next: string) => {
    if (next === MANAGE_SENTINEL) {
      setManageOpen(true)
      return
    }
    setCurrentSpace(next)
  }

  return (
    <TooltipProvider>
      <Select value={currentSpaceId ?? ''} onValueChange={handleValueChange}>
        {/*
         * UX-9 — surface the `Ctrl+1..9` / `⌘1..9` space-switching
         * shortcuts via a tooltip on the trigger so users discover
         * them without opening the `?` keyboard help dialog. The
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
                  'w-full justify-between',
                  // Inherit the sidebar's tight typography while preserving
                  // the 44px touch target via the Select's built-in
                  // `[@media(pointer:coarse)]:h-11` rule.
                  'text-sm font-medium',
                )}
              >
                {/*
                 * FEAT-3p11 — keep the digit-hint chip scoped to the
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
          <TooltipContent>{t('spaceSwitcher.shortcutHint')}</TooltipContent>
        </Tooltip>
        <SelectContent>
          {availableSpaces.map((space, idx) => (
            <SelectItem
              key={space.id}
              value={space.id}
              endContent={
                idx < MAX_HOTKEY_SPACES ? (
                  /*
                   * FEAT-3p11 — right-aligned digit-hint chip (`Ctrl+1` /
                   * `⌘1`) for the first nine spaces. Rendered via
                   * `SelectItem`'s `endContent` slot so it stays out of
                   * `<SelectPrimitive.ItemText>` and therefore out of
                   * Radix's auto-mirror into the trigger label.
                   */
                  <span
                    aria-hidden="true"
                    className="ml-auto text-xs text-muted-foreground"
                    data-testid={`space-hotkey-hint-${idx + 1}`}
                  >
                    {spaceHotkeyHint(idx)}
                  </span>
                ) : undefined
              }
            >
              {space.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          {/*
           * FEAT-3 Phase 6 — the "Manage spaces…" entry is now a real,
           * enabled action. `handleValueChange` short-circuits the
           * sentinel and opens `SpaceManageDialog` instead of calling
           * `setCurrentSpace`, so selecting it does not switch space.
           */}
          <SelectItem value={MANAGE_SENTINEL} className="text-muted-foreground">
            {t('space.manage')}
          </SelectItem>
        </SelectContent>
      </Select>
      <SpaceManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </TooltipProvider>
  )
}
