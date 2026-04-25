/**
 * SpaceSwitcher — sidebar-top space selector (FEAT-3 Phase 1).
 *
 * Renders a Radix Select bound to `useSpaceStore`. Changing the selection
 * updates `currentSpaceId` synchronously; later phases (Phase 2+) will
 * react to that id to scope list/search queries. Phase 1 ships the UI
 * surface + data plumbing only — the switcher itself does not re-scope
 * anything yet, but every affected panel will subscribe to it in later
 * phases.
 *
 * The "Manage spaces…" entry is a deliberately-disabled placeholder with
 * a tooltip ("Coming in Phase 6") so users understand the option exists.
 */

import { useEffect } from 'react'
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
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

/**
 * Sentinel value used by the disabled "Manage spaces…" item so Radix
 * Select never routes it through `onValueChange`. `SelectItem` requires
 * a non-empty `value`, so a unique reserved string is the simplest way
 * to keep the option visually present without participating in
 * selection.
 */
const MANAGE_SENTINEL = '__manage__'

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

  const handleValueChange = (next: string) => {
    if (next === MANAGE_SENTINEL) return
    setCurrentSpace(next)
  }

  return (
    <TooltipProvider>
      <Select value={currentSpaceId ?? ''} onValueChange={handleValueChange}>
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
          <SelectValue placeholder={t('space.switch')} />
        </SelectTrigger>
        <SelectContent>
          {availableSpaces.map((space) => (
            <SelectItem key={space.id} value={space.id}>
              {space.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <Tooltip>
            <TooltipTrigger asChild>
              {/*
               * Radix SelectItem swallows hover/focus when disabled, so
               * wrap in a span that forwards pointer events to the
               * tooltip trigger. `aria-disabled` keeps the label in the
               * accessibility tree while `data-[disabled]` suppresses
               * the hover highlight.
               */}
              {/*
               * UX-284: the tooltip on this disabled entry never fires
               * on touch — Radix only opens it on hover/focus. Append a
               * small "(ⓘ)" affordance to the label so mobile users
               * still see a visible "there is more context here" hint.
               * The U+24D8 codepoint is text-only, which keeps the
               * SelectItem's native-`<option>` test mock happy; the
               * tooltip's `space.manageComingSoon` string remains the
               * accessible source of truth (this is decorative).
               */}
              <span>
                <SelectItem
                  value={MANAGE_SENTINEL}
                  disabled
                  aria-disabled="true"
                  className="text-muted-foreground"
                >
                  {t('space.manage')} ⓘ
                </SelectItem>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{t('space.manageComingSoon')}</TooltipContent>
          </Tooltip>
        </SelectContent>
      </Select>
    </TooltipProvider>
  )
}
