/**
 * The toolbar's block-menu button, opening the block menu on the block the
 * cursor is in, below the button: on *Edit as Markdown*'s bar
 * (`PageSourceToolbar`), and on page mode's on touch, where a long press in
 * the text belongs to the phone (`page-toolbar.tsx`).
 */

import { GripVertical } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { type RenderMode, Tip } from '@/components/FormattingToolbar/shared'
import { toolbarMenuRowClass } from '@/components/FormattingToolbar/toolbar-config'
import { Button } from '@/components/ui/button'
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
  const press: Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onPointerDown' | 'onClick'> = {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      onOpen(e.currentTarget)
    },
    onClick: (e) => {
      if (e.detail === 0) onOpen(e.currentTarget)
    },
  }
  const common = {
    'aria-label': t('contextMenu.blockActions'),
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    disabled,
    ...press,
  }
  if (mode === 'overflow') {
    return (
      <Button variant="ghost" size="sm" className={toolbarMenuRowClass} {...common}>
        <GripVertical className="mr-2" />
        <span>{t('contextMenu.blockActions')}</span>
      </Button>
    )
  }
  return (
    <Tip label={t('pageSource.blockMenuTip')}>
      <Button variant="ghost" size="icon-xs" {...common}>
        <GripVertical />
      </Button>
    </Tip>
  )
}
