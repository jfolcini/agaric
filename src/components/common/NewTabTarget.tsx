/**
 * NewTabTarget — wraps one element that opens a page, so a middle click on it,
 * or "Open in new tab" in its right-click (on touch, long-press) menu, opens
 * the page in a background tab. With `dragsPage`, dragging it into the editor
 * links the page there (`page-drag.ts`); only where asked, since a draggable
 * element takes the press that would select its text. On mobile, which shows
 * no tabs, the element renders untouched.
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
import { setPageDragData } from '@/lib/page-drag'

export interface NewTabTargetProps {
  pageId: string
  title: string
  /** Dragging the element carries the page (`page-drag.ts`). */
  dragsPage?: boolean
  /** One element that takes a ref and event props. */
  children: React.ReactElement
}

export function NewTabTarget({
  pageId,
  title,
  dragsPage = false,
  children,
}: NewTabTargetProps): React.ReactElement {
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
        {...(dragsPage && {
          draggable: true,
          onDragStart: (e: React.DragEvent) => setPageDragData(e.dataTransfer, pageId),
        })}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={openPage}>{t('tabs.openInNewTab')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
