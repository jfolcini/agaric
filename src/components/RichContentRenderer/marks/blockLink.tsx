import type React from 'react'
import { useId, useState } from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { BlockLinkNode } from '@/editor/types'
import { i18n } from '@/lib/i18n'
import { keepFocusThatMovedOn } from '@/lib/keep-focus-that-moved-on'
import { getPageDisplayName } from '@/lib/page-display'
import { cn } from '@/lib/utils'

/**
 * Build the event-handler + role props bundle for a clickable block-link chip.
 * Mirrors `tagRefProps` / `blockRefProps`: returns `{ role: 'link', tabIndex: 0,
 * onClick, onKeyDown }` with Enter + Space activation and `stopPropagation` on
 * every handler.
 *
 * Only spread when the chip is clickable (handler AND interactive). The caller
 * gates on both conditions, so this helper only ever produces the active bag.
 */
function blockLinkProps(linkId: string, onNavigate: (id: string) => void): Record<string, unknown> {
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onNavigate(linkId)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(linkId)
      }
    },
  }
}

/**
 * A broken link in content that can be edited: a tap explains it, with a Remove
 * button, so a stray tap removes nothing (#6895). No `data-editor-portal`: the
 * chip renders in a static block, which has no editor for the popover to keep.
 */
function BrokenBlockLink({
  node,
  label,
  anchored,
  remove,
}: {
  node: BlockLinkNode
  label: string
  anchored: boolean
  remove: (link: BlockLinkNode) => void
}): React.ReactElement {
  const chipId = useId()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={chipId}
          type="button"
          className={cn(
            'block-link-chip block-link-deleted inline cursor-pointer',
            anchored && 'ref-chip-anchor',
          )}
          data-testid="block-link-chip"
          // The press must not put the block into edit mode.
          onClick={(e) => e.stopPropagation()}
        >
          {label}
          <span className="sr-only"> {i18n.t('editor.brokenLinkState')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-labelledby={chipId}
        className="w-auto max-w-xs space-y-2 p-3 text-sm"
        // Removing the link moves the focus to the block's row.
        onCloseAutoFocus={keepFocusThatMovedOn}
        onClick={(e) => e.stopPropagation()}
      >
        <p>{i18n.t('editor.brokenLinkExplanation')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false)
            remove(node)
          }}
        >
          {i18n.t('editor.brokenLinkRemove')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function renderBlockLink(
  node: BlockLinkNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const linkId = node.attrs.id
  const title = ctx.resolveBlockTitle?.(linkId) ?? `[[${linkId.slice(0, 8)}...]]`
  const status = ctx.resolveBlockStatus?.(linkId) ?? 'active'
  // Bug 1: inline `[[link]]` chip renders the LEAF only. The full
  // path stays available via the `title=""` tooltip — the chip lives inside
  // flowing text where a full namespaced path overflows the line. A stored
  // label is shown in the leaf's place (#5160 D9).
  const label = node.attrs.label ?? getPageDisplayName(title, 'leaf').label
  if (status === 'deleted' && ctx.interactive === true && ctx.removeBrokenLink !== undefined) {
    return (
      <BrokenBlockLink
        key={key}
        node={node}
        label={label}
        anchored={linkId === ctx.anchorRefId}
        remove={ctx.removeBrokenLink}
      />
    )
  }
  // The name opens with the shown label, not the title: voice control matches
  // on what the user sees (WCAG 2.5.3); the full path stays in `title`.
  const deletedProps = status === 'deleted' ? { 'aria-label': `${label} (deleted)` } : {}
  // Unified chip interactivity policy (matches tagRef / blockRef):
  // - clickable (handler AND interactive) → full affordances: role=link,
  //   tabIndex=0, key/click handlers, cursor-pointer.
  // - interactive but no handler → inert focus parity: tabIndex=0 only.
  // - not interactive → fully inert: no role, no tabIndex, no handlers, no
  //   cursor-pointer.
  const clickable = ctx.onNavigate !== undefined && ctx.interactive === true
  const inertProps: Record<string, unknown> = ctx.interactive === true ? { tabIndex: 0 } : {}
  const interactiveProps = clickable
    ? blockLinkProps(linkId, ctx.onNavigate as (id: string) => void)
    : inertProps
  return (
    <span
      key={key}
      className={cn(
        'block-link-chip',
        clickable && 'cursor-pointer',
        status === 'deleted' && 'block-link-deleted',
        linkId === ctx.anchorRefId && 'ref-chip-anchor',
      )}
      data-testid="block-link-chip"
      // The editor's NodeView carries the same pair; `pageLinkIdAt` finds either.
      {...(clickable ? { 'data-type': 'block-link', 'data-id': linkId } : {})}
      title={title}
      {...deletedProps}
      {...interactiveProps}
    >
      {label}
    </span>
  )
}
