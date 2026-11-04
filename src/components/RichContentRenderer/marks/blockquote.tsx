import type React from 'react'
import { useState } from 'react'

import {
  CALLOUT_CONFIG,
  HEADING_CLASSES,
  type RenderContext,
} from '@/components/RichContentRenderer/context'
import { renderInlineContent } from '@/components/RichContentRenderer/marks/inline'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import type { BlockLevelNode, BlockquoteNode } from '@/editor/types'
import { calloutStyle } from '@/lib/callout-style'
import { i18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * Signature of the block dispatcher (`renderBlock`). Injected as a parameter
 * rather than imported so this module never imports `./block` (which imports
 * this one) — keeping the marks module graph acyclic (#1534).
 */
type RenderBlockFn = (
  block: BlockLevelNode,
  key: string,
  ctx: RenderContext,
) => React.ReactElement | React.ReactNode[] | null

/**
 * Cap recursion when blockquote children themselves contain blockquotes, to
 * guard against pathological nesting (and any cyclic node graph).
 */
const MAX_BLOCKQUOTE_DEPTH = 16

function renderBlockquoteChild(
  child: BlockLevelNode,
  key: string,
  ctx: RenderContext,
  depth: number,
  renderBlockNode: RenderBlockFn,
): React.ReactNode {
  if (child.type === 'paragraph') {
    const inlined = child.content ? renderInlineContent(child.content, `${key}-i`, ctx) : []
    return <p key={key}>{inlined}</p>
  }
  if (child.type === 'heading') {
    const HTag = `h${child.attrs.level}` as keyof React.JSX.IntrinsicElements
    const hCls = HEADING_CLASSES[child.attrs.level] ?? ''
    const inlined = child.content ? renderInlineContent(child.content, `${key}-i`, ctx) : []
    return (
      <HTag key={key} className={hCls}>
        {inlined}
      </HTag>
    )
  }
  // Bail out past the depth cap to guard against pathological / cyclic
  // nesting before recursing further.
  if (depth >= MAX_BLOCKQUOTE_DEPTH) return null
  // Render nested blockquotes/callouts via the local renderer so depth keeps
  // accumulating across the nesting.
  if (child.type === 'blockquote') {
    return renderBlockquoteBlock(child, key, ctx, renderBlockNode, depth + 1)
  }
  // Recurse through full block dispatch for any other child type (nested
  // lists, code, tasks) so non-paragraph content is not silently dropped
  // (#1534).
  return renderBlockNode(child, key, ctx)
}

interface CalloutBlockProps {
  calloutType: string
  fold: '+' | '-' | undefined
  /** What a folded callout shows while closed. */
  title: React.ReactNode
  children: React.ReactNode[]
}

/**
 * A callout in the style its type maps to (`calloutStyle`), labelled with that
 * style's name so a custom type never shows a raw `callout.<type>` key
 * (#2275). A `-` / `+` fold marker adds a toggle, starting closed / open,
 * that shows the title alone while closed. Open or closed is view state:
 * nothing is saved, and the editor shows the callout whole.
 */
function CalloutBlock({
  calloutType,
  fold,
  title,
  children,
}: CalloutBlockProps): React.ReactElement {
  const [open, setOpen] = useState(fold !== '-')
  const style = calloutStyle(calloutType)
  const config = CALLOUT_CONFIG[style]
  if (!config) return <blockquote>{children}</blockquote>
  const CalloutIcon = config.icon
  const label = i18n.t(`callout.${style}`)
  return (
    <blockquote
      className={cn('border-l-[3px] pl-4 py-2 rounded-r-md', config.borderClass, config.bgClass)}
      data-callout-type={calloutType}
      data-testid="callout-block"
    >
      <div className={cn('flex items-center gap-1.5 font-semibold text-sm mb-1', config.textClass)}>
        {/* The header pins text-sm, so the icon sizes from the setting itself (#5369). */}
        <CalloutIcon className="size-[var(--agaric-font-size,1rem)] shrink-0" aria-hidden="true" />
        <span>{label}</span>
        {fold !== undefined && (
          <button
            type="button"
            className="shrink-0 rounded-sm p-0.5 focus-ring-visible touch-hit-area"
            data-testid="callout-fold-toggle"
            aria-expanded={open}
            aria-label={i18n.t(open ? 'callout.collapse' : 'callout.expand', { name: label })}
            // Like `CollapsibleImage`'s toggle: keep the editor's focus on
            // mousedown, and keep the click and Enter/Space from reaching the
            // row's own handlers, which would open the block for editing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            }}
          >
            <ChevronToggle isExpanded={open} size="md" solidWhenCollapsed />
          </button>
        )}
      </div>
      <div className="text-foreground">{open ? children : title}</div>
    </blockquote>
  )
}

/**
 * A callout's title: its first line, which is the first child up to its first
 * hard break (`> [!faq]- Why?` / `> Because.` parse as one paragraph).
 */
function renderCalloutTitle(
  content: readonly BlockLevelNode[],
  key: string,
  ctx: RenderContext,
  depth: number,
  renderBlockNode: RenderBlockFn,
): React.ReactNode {
  const first = content[0]
  if (first === undefined) return null
  if (first.type !== 'paragraph') {
    return renderBlockquoteChild(first, `${key}-0`, ctx, depth, renderBlockNode)
  }
  const inline = first.content ?? []
  const breakAt = inline.findIndex((node) => node.type === 'hardBreak')
  const line = breakAt < 0 ? first : { ...first, content: inline.slice(0, breakAt) }
  return renderBlockquoteChild(line, `${key}-0`, ctx, depth, renderBlockNode)
}

export function renderBlockquoteBlock(
  block: BlockquoteNode,
  key: string,
  ctx: RenderContext,
  renderBlockNode: RenderBlockFn,
  depth = 0,
): React.ReactElement {
  const content = block.content ?? []
  const children: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const child = content[i] as BlockLevelNode
    const rendered = renderBlockquoteChild(child, `${key}-${i}`, ctx, depth, renderBlockNode)
    if (rendered != null) children.push(rendered)
  }
  const calloutType = block.attrs?.calloutType
  if (calloutType) {
    const fold = block.attrs?.calloutFold
    const title =
      fold === undefined ? null : renderCalloutTitle(content, key, ctx, depth, renderBlockNode)
    return (
      <CalloutBlock key={key} calloutType={calloutType} fold={fold} title={title}>
        {children}
      </CalloutBlock>
    )
  }
  return (
    <blockquote key={key} className="border-l-[3px] border-border pl-4 text-muted-foreground">
      {children}
    </blockquote>
  )
}
