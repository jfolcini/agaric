/**
 * EditModeSwitch — a page header's Blocks | Page switch (#5691): the page on
 * screen edited one block at a time or as one document. Page's tooltip names
 * its shortcut; where page mode cannot show the page yet, Page is
 * `aria-disabled`, not `disabled`, so the tooltip can say why instead, and
 * choosing it does nothing.
 */

import type React from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

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
  const reasonId = useId()
  const page = (
    <ToggleGroupItem
      value="page"
      aria-disabled={blocked ? true : undefined}
      aria-describedby={blocked ? reasonId : undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    >
      {t('pageMode.page')}
    </ToggleGroupItem>
  )
  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(next) => {
        // Radix reports '' when the pressed item is pressed again.
        if (next === 'blocks' || (next === 'page' && !blocked)) onChange(next)
      }}
      aria-label={t('pageMode.switchLabel')}
    >
      <ToggleGroupItem value="blocks">{t('pageMode.blocks')}</ToggleGroupItem>
      {/* One tooltip throughout: a reason found while it is open replaces the hint. */}
      <Tooltip>
        <TooltipTrigger asChild>{page}</TooltipTrigger>
        <TooltipContent>
          {blocked || `${t('pageMode.pageHint')} (${getShortcutKeys('togglePageMode')})`}
        </TooltipContent>
      </Tooltip>
      {blocked && (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
    </ToggleGroup>
  )
}
