/**
 * NewTabTarget — wraps one element that opens a page, so a middle click on it,
 * or "Open in new tab" in its right-click (on touch, long-press) menu, opens
 * the page in a background tab. On mobile, which shows no tabs, the element
 * renders untouched.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { delegatedMiddleClickProps, useOpenInBackgroundTab } from '@/hooks/useOpenInBackgroundTab'

export interface NewTabTargetProps {
  pageId: string
  title: string
  /** One element that takes a ref and event props. */
  children: React.ReactElement
}

export function NewTabTarget({ pageId, title, children }: NewTabTargetProps): React.ReactElement {
  const { t } = useTranslation()
  const open = useOpenInBackgroundTab()
  if (open === undefined) return children
  const openPage = () => open(pageId, title)
  // A long-press opened the menu, so the release is no tap, and an enclosing
  // block must not open its own menu as well.
  const claimRelease = (e: React.TouchEvent) => {
    if (e.currentTarget.getAttribute('data-state') === 'open') e.preventDefault()
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        {...delegatedMiddleClickProps(() => openPage)}
        onTouchEnd={claimRelease}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={openPage}>{t('tabs.openInNewTab')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
