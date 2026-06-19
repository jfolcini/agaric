import type React from 'react'

import type { BlockLevelNode, BlockquoteNode } from '../../../editor/types'
import { i18n } from '../../../lib/i18n'
import { cn } from '../../../lib/utils'
import { CALLOUT_CONFIG, HEADING_CLASSES, type RenderContext } from '../context'
import { renderInlineContent } from './inline'

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

function renderCalloutBlock(
  calloutType: string,
  children: React.ReactNode[],
  key: string,
): React.ReactElement {
  const config = CALLOUT_CONFIG[calloutType] ?? CALLOUT_CONFIG['note']
  if (!config) return <blockquote key={key}>{children}</blockquote>
  const CalloutIcon = config.icon
  return (
    <blockquote
      key={key}
      className={cn('border-l-[3px] pl-4 py-2 rounded-r-md', config.borderClass, config.bgClass)}
      data-callout-type={calloutType}
      data-testid="callout-block"
    >
      <div className={cn('flex items-center gap-1.5 font-semibold text-sm mb-1', config.textClass)}>
        <CalloutIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{i18n.t(`callout.${calloutType}`)}</span>
      </div>
      <div className="text-foreground">{children}</div>
    </blockquote>
  )
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
  if (calloutType) return renderCalloutBlock(calloutType, children, key)
  return (
    <blockquote key={key} className="border-l-[3px] border-border pl-4 text-muted-foreground">
      {children}
    </blockquote>
  )
}
