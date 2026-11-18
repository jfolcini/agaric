/**
 * EditModeSwitch — the Blocks | Page switch (#5691): the page on screen edited
 * one block at a time or as one document. Page's tooltip names
 * its shortcut; where page mode cannot show the page yet, Page is
 * `aria-disabled`, an ⓘ beside the switch saying why, and choosing it does
 * nothing. A press keeps the focus where it was, so the switch
 * finds the caret being typed at, in either mode, still there. It shows in a
 * page's header and on the journal's day (on a phone, their *Page actions*
 * menu has the item instead); its shortcut is the page's
 * (`useEditModeShortcut`).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { InfoPopover } from '@/components/ui/info-popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getShortcutKeys } from '@/lib/keyboard-config'
import type { EditMode } from '@/lib/preferences'

export interface EditModeSwitchProps {
  mode: EditMode
  onChange: (mode: EditMode) => void
  /** Why page mode is not offered for this page, or nothing. */
  blocked?: string | null | undefined
}

export function EditModeSwitch({
  mode,
  onChange,
  blocked,
}: EditModeSwitchProps): React.ReactElement {
  const { t } = useTranslation()
  const page = (
    <ToggleGroupItem
      value="page"
      aria-disabled={blocked ? true : undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    >
      {t('pageMode.page')}
    </ToggleGroupItem>
  )
  return (
    // One box, so the ⓘ keeps its gap and never wraps away from the switch.
    <span className="inline-flex items-center gap-1">
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(next) => {
          // Radix reports '' when the pressed item is pressed again.
          if (next === 'blocks' || (next === 'page' && !blocked)) onChange(next)
        }}
        aria-label={t('pageMode.switchLabel')}
        onMouseDown={(event) => event.preventDefault()}
      >
        <ToggleGroupItem value="blocks">{t('pageMode.blocks')}</ToggleGroupItem>
        {/* Always the same element, so a reason that arrives while Page has
            focus does not remount it and drop the focus; the hint just stays
            shut while the ⓘ carries the reason. */}
        <Tooltip {...(blocked ? { open: false } : {})}>
          <TooltipTrigger asChild>{page}</TooltipTrigger>
          <TooltipContent>
            {`${t('pageMode.pageHint')} (${getShortcutKeys('togglePageMode')})`}
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>
      {blocked && (
        <InfoPopover variant="icon" ariaLabel={t('pageMode.blockedInfo')} content={blocked} />
      )}
    </span>
  )
}
