/**
 * The toolbar's block-menu button, opening the block menu on the block the
 * cursor is in, below the button: on *Edit as Markdown*'s bar
 * (`PageSourceToolbar`), and on page mode's on touch, where a long press in
 * the text belongs to the phone (`page-toolbar.tsx`).
 */

import { GripVertical } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { type RenderMode, toolbarPressHandlers } from '@/components/FormattingToolbar/shared'
import { toolbarMenuRowClass } from '@/components/FormattingToolbar/toolbar-config'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import type { ToolbarItem } from '@/hooks/useToolbarOverflow'

/** Its item key on the bar. */
export const BLOCK_MENU = 'pageSource.blockMenu'

/** Its items, after the bar's own: a separator, then the button, which outlasts most in overflow. */
export const BLOCK_MENU_ITEMS: readonly ToolbarItem[] = [
  { kind: 'separator', key: 'sep-3', group: 3, priority: 0 },
  { kind: 'button', key: BLOCK_MENU, group: 4, priority: 85 },
]

interface BlockMenuButtonProps {
  mode: RenderMode
  disabled: boolean
  open: boolean
  onOpen: (anchor: HTMLElement) => void
}

export function BlockMenuButton({ mode, disabled, open, onOpen }: BlockMenuButtonProps) {
  const { t } = useTranslation()
  // A finger opens the menu on its lift, not its press, so the lift lands on the
  // button and not on the menu's sheet the press would have put under it.
  const press = toolbarPressHandlers(onOpen)
  const common = {
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    disabled,
    ...press,
  }
  if (mode === 'overflow') {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={toolbarMenuRowClass}
        aria-label={t('contextMenu.blockActions')}
        {...common}
      >
        <GripVertical className="mr-2" />
        <span>{t('contextMenu.blockActions')}</span>
      </Button>
    )
  }
  return (
    <IconButton
      variant="ghost"
      size="icon-xs"
      tooltip={t('pageSource.blockMenuTip')}
      ariaLabel={t('contextMenu.blockActions')}
      {...common}
    >
      <GripVertical />
    </IconButton>
  )
}
