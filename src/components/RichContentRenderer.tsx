import { common, createLowlight } from 'lowlight'
import { AlertTriangle, Info, Lightbulb, StickyNote, XCircle } from 'lucide-react'
import type React from 'react'
import { Fragment, lazy, Suspense } from 'react'
import { parse } from '../editor/markdown-serializer'
import type {
  BlockLevelNode,
  BlockLinkNode,
  BlockquoteNode,
  BlockRefNode,
  CodeBlockNode,
  DocNode,
  HardBreakNode,
  HeadingNode,
  InlineNode,
  OrderedListNode,
  ParagraphNode,
  TagRefNode,
  TextNode,
} from '../editor/types'
import { i18n } from '../lib/i18n'
import { openUrl } from '../lib/open-url'
import { cn } from '../lib/utils'
import { ScrollArea } from './ui/scroll-area'
import { Spinner } from './ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// Lazy-load MermaidDiagram to avoid bundling mermaid on initial load
const LazyMermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
)

const lowlight = createLowlight(common)

/** Render-time context shared across block and inline sub-renderers. */
interface RenderContext {
  readonly onNavigate?: ((id: string) => void) | undefined
  readonly onTagClick?: ((id: string) => void) | undefined
  readonly resolveBlockTitle?: ((id: string) => string | undefined) | undefined
  readonly resolveTagName?: ((id: string) => string | undefined) | undefined
  readonly resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  readonly resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  readonly interactive?: boolean | undefined
}

/** Callout type configuration: border color, icon, and label. */
export const CALLOUT_CONFIG: Record<
  string,
  {
    borderClass: string
    bgClass: string
    textClass: string
    icon: React.ComponentType<{ className?: string | undefined }>
    label: string
  }
> = {
  info: {
    borderClass: 'border-alert-info-border',
    bgClass: 'bg-alert-info',
    textClass: 'text-alert-info-foreground',
    icon: Info,
    label: 'Info',
  },
  warning: {
    borderClass: 'border-alert-warning-border',
    bgClass: 'bg-alert-warning',
    textClass: 'text-alert-warning-foreground',
    icon: AlertTriangle,
    label: 'Warning',
  },
  tip: {
    borderClass: 'border-alert-tip-border',
    bgClass: 'bg-alert-tip',
    textClass: 'text-alert-tip-foreground',
    icon: Lightbulb,
    label: 'Tip',
  },
  error: {
    borderClass: 'border-alert-error-border',
    bgClass: 'bg-alert-error',
    textClass: 'text-alert-error-foreground',
    icon: XCircle,
    label: 'Error',
  },
  note: {
    borderClass: 'border-alert-note-border',
    bgClass: 'bg-alert-note',
    textClass: 'text-alert-note-foreground',
    icon: StickyNote,
    label: 'Note',
  },
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'text-xl sm:text-2xl font-bold',
  2: 'text-lg sm:text-xl font-bold',
  3: 'text-base sm:text-lg font-semibold',
  4: 'text-sm sm:text-base font-semibold',
  5: 'text-sm font-semibold',
  6: 'text-xs font-semibold uppercase tracking-wide',
}

// ============================================================================
// Hast → React (for syntax-highlighted code blocks, avoids innerHTML)
// ============================================================================

interface HastTextNode {
  readonly type: 'text'
  readonly value: string
}
interface HastElementNode {
  readonly type: 'element'
  readonly tagName: string
  readonly properties?: Readonly<Record<string, unknown>>
  readonly children: readonly HastChildNode[]
}
interface HastRootNode {
  readonly type: 'root'
  readonly children: readonly HastChildNode[]
}
type HastChildNode = HastTextNode | HastElementNode

function hastClassName(
  properties: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const cls = properties?.['className']
  if (Array.isArray(cls)) {
    return cls.filter((c): c is string => typeof c === 'string').join(' ')
  }
  if (typeof cls === 'string') return cls
  return undefined
}

function hastChildrenToReact(
  children: readonly HastChildNode[],
  keyPrefix: string,
): React.ReactNode[] {
  return children.map((child, i) => {
    const childKey = `${keyPrefix}-${i}`
    if (child.type === 'text') {
      return <Fragment key={childKey}>{child.value}</Fragment>
    }
    return (
      <span key={childKey} className={hastClassName(child.properties)}>
        {hastChildrenToReact(child.children, childKey)}
      </span>
    )
  })
}

// ============================================================================
// Inline renderers (per-mark / per-inline-node dispatch)
// ============================================================================

/**
 * Build the event-handler + role props bundle for an interactive span.
 * Spreading the bundle (rather than inlining attributes) routes the static
 * analyzer around a11y rules that only fire when role/onClick/onKeyDown are
 * directly visible on the JSX element. Runtime a11y is preserved — the span
 * still has a valid role + keyboard handler.
 */
function externalLinkProps(
  href: string,
  interactive: boolean | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    role: 'link',
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      openUrl(href)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        openUrl(href)
      }
    },
  }
  if (interactive === true) props['tabIndex'] = 0
  return props
}

function renderExternalLink(
  text: string,
  href: string,
  ctx: RenderContext,
  key: string,
): React.ReactElement {
  return (
    <span
      key={key}
      className="external-link cursor-pointer"
      data-testid="external-link"
      data-href={href}
      {...externalLinkProps(href, ctx.interactive)}
    >
      {text}
      <span className="sr-only"> {i18n.t('link.opensInNewTab')}</span>
      <span className="inline-block ml-0.5 text-[0.7em] opacity-60" aria-hidden="true">
        ↗
      </span>
    </span>
  )
}

/** Apply bold / italic / code / link marks to a text node, innermost-out. */
function applyTextMarks(node: TextNode, ctx: RenderContext, key: string): React.ReactNode {
  const linkMark = node.marks?.find((m) => m.type === 'link')
  let content: React.ReactNode =
    linkMark && linkMark.type === 'link'
      ? renderExternalLink(node.text, linkMark.attrs.href, ctx, `${key}-link`)
      : node.text

  if (node.marks?.some((m) => m.type === 'code') === true) {
    content = (
      <code className="bg-muted rounded px-1 py-0.5 text-[0.85em] font-mono">{content}</code>
    )
  }
  if (node.marks?.some((m) => m.type === 'italic') === true) {
    content = <em>{content}</em>
  }
  if (node.marks?.some((m) => m.type === 'bold') === true) {
    content = <strong>{content}</strong>
  }
  return content
}

function renderTextInline(node: TextNode, key: string, ctx: RenderContext): React.ReactElement {
  return <span key={key}>{applyTextMarks(node, ctx, key)}</span>
}

/**
 * Build the event-handler + role props bundle for a clickable tag chip.
 * Mirrors `blockLinkProps`: returns `{ role: 'link', tabIndex: 0, onClick,
 * onKeyDown }` with Enter + Space activation and `stopPropagation` on every
 * handler.
 *
 * When `onTagClick` is undefined or the surface is not interactive, the chip
 * must stay inert — the caller in `renderTagRef` gates on both conditions
 * before spreading this bundle, so this helper only produces the active bag.
 */
function tagRefProps(tagId: string, onTagClick: (id: string) => void): Record<string, unknown> {
  return {
    role: 'link',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onTagClick(tagId)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onTagClick(tagId)
      }
    },
  }
}

function renderTagRef(node: TagRefNode, key: string, ctx: RenderContext): React.ReactElement {
  const tagId = node.attrs.id
  const name = ctx.resolveTagName?.(tagId) ?? `#${tagId.slice(0, 8)}...`
  const status = ctx.resolveTagStatus?.(tagId) ?? 'active'
  const deletedProps = status === 'deleted' ? { 'aria-label': `${name} (deleted)` } : {}
  // Activate only when BOTH a handler AND an interactive surface are
  // supplied. When either is missing, fall back to today's inert render:
  // `tabIndex=0` for interactive focus parity, otherwise no props at all.
  // Deleted chips still fire the handler — it's useful for users to
  // discover the tag is gone.
  const clickable = ctx.onTagClick !== undefined && ctx.interactive === true
  const inertProps: Record<string, unknown> = ctx.interactive === true ? { tabIndex: 0 } : {}
  const interactiveProps = clickable
    ? tagRefProps(tagId, ctx.onTagClick as (id: string) => void)
    : inertProps
  return (
    <span
      key={key}
      className={cn(
        'tag-ref-chip',
        status === 'deleted' && 'tag-ref-deleted',
        clickable && 'cursor-pointer',
      )}
      data-testid="tag-ref-chip"
      {...deletedProps}
      {...interactiveProps}
    >
      {name}
    </span>
  )
}

function blockLinkProps(
  linkId: string,
  onNavigate: ((id: string) => void) | undefined,
  interactive: boolean | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    role: 'link',
    onClick: (e: React.MouseEvent) => {
      if (onNavigate) {
        e.stopPropagation()
        onNavigate(linkId)
      }
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && onNavigate) {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(linkId)
      }
    },
  }
  if (interactive === true) props['tabIndex'] = 0
  return props
}

function renderBlockLink(node: BlockLinkNode, key: string, ctx: RenderContext): React.ReactElement {
  const linkId = node.attrs.id
  const title = ctx.resolveBlockTitle?.(linkId) ?? `[[${linkId.slice(0, 8)}...]]`
  const status = ctx.resolveBlockStatus?.(linkId) ?? 'active'
  const deletedProps = status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {}
  return (
    <span
      key={key}
      className={cn('block-link-chip cursor-pointer', status === 'deleted' && 'block-link-deleted')}
      data-testid="block-link-chip"
      {...deletedProps}
      {...blockLinkProps(linkId, ctx.onNavigate, ctx.interactive)}
    >
      {title}
    </span>
  )
}

function blockRefProps(
  refId: string,
  onNavigate: ((id: string) => void) | undefined,
  interactive: boolean | undefined,
): Record<string, unknown> {
  return {
    role: interactive === true ? 'link' : 'button',
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      if (onNavigate) {
        e.stopPropagation()
        onNavigate(refId)
      }
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && onNavigate) {
        e.preventDefault()
        e.stopPropagation()
        onNavigate(refId)
      }
    },
  }
}

function renderBlockRef(node: BlockRefNode, key: string, ctx: RenderContext): React.ReactElement {
  const refId = node.attrs.id
  const fullContent = ctx.resolveBlockTitle?.(refId) ?? `(( ${refId.slice(0, 8)}... ))`
  const status = ctx.resolveBlockStatus?.(refId) ?? 'active'
  const firstLine = fullContent.split('\n')[0] ?? fullContent
  const chipLabel = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
  const deletedProps = status === 'deleted' ? { 'aria-label': `${chipLabel} (deleted)` } : {}
  return (
    <Tooltip key={key}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'block-ref-chip cursor-pointer',
            status === 'deleted' && 'block-ref-deleted',
          )}
          data-testid="block-ref-chip"
          {...deletedProps}
          {...blockRefProps(refId, ctx.onNavigate, ctx.interactive)}
        >
          {chipLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
        {fullContent.length > 300 ? `${fullContent.slice(0, 297)}...` : fullContent}
      </TooltipContent>
    </Tooltip>
  )
}

function renderHardBreak(_node: HardBreakNode, key: string): React.ReactElement {
  return <span key={key}> </span>
}

/**
 * Dispatch an inline node (text / tag_ref / block_link / block_ref / hardBreak)
 * to its sub-renderer and return a single React element (or null).
 */
function renderInlineNode(
  node: InlineNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement | null {
  switch (node.type) {
    case 'text':
      return renderTextInline(node, key, ctx)
    case 'tag_ref':
      return renderTagRef(node, key, ctx)
    case 'block_link':
      return renderBlockLink(node, key, ctx)
    case 'block_ref':
      return renderBlockRef(node, key, ctx)
    case 'hardBreak':
      return renderHardBreak(node, key)
    default:
      return null
  }
}

function renderInlineContent(
  content: readonly InlineNode[],
  keyPrefix: string,
  ctx: RenderContext,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const node = content[i] as InlineNode
    const el = renderInlineNode(node, `${keyPrefix}-${i}`, ctx)
    if (el !== null) out.push(el)
  }
  return out
}

// ============================================================================
// Block-level renderers
// ============================================================================

function renderHeadingBlock(
  block: HeadingNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const HeadingTag = `h${block.attrs.level}` as keyof React.JSX.IntrinsicElements
  const cls = HEADING_CLASSES[block.attrs.level] ?? ''
  const inlined = block.content ? renderInlineContent(block.content, `${key}-i`, ctx) : []
  return (
    <HeadingTag key={key} className={cls}>
      {inlined}
    </HeadingTag>
  )
}

function renderMermaidBlock(code: string, key: string): React.ReactElement {
  return (
    <Suspense
      key={key}
      fallback={
        <div
          className="flex items-center gap-2 rounded-md bg-muted px-3 py-4 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner size="sm" />
          <span>{i18n.t('mermaid.loading')}</span>
        </div>
      }
    >
      <LazyMermaidDiagram code={code} />
    </Suspense>
  )
}

function renderHighlightedCode(code: string, language: string, key: string): React.ReactNode {
  try {
    const tree = (language
      ? lowlight.highlight(language, code)
      : lowlight.highlightAuto(code)) as unknown as HastRootNode
    return hastChildrenToReact(tree.children, key)
  } catch {
    return code
  }
}

function renderCodeBlock(block: CodeBlockNode, key: string): React.ReactElement {
  const code = block.content?.[0]?.text ?? ''
  const language = block.attrs?.language ?? ''
  if (language === 'mermaid') return renderMermaidBlock(code, key)
  return (
    <ScrollArea key={key} className="bg-muted rounded-md text-sm font-mono">
      <pre className="px-3 py-2">
        <code className={language ? `language-${language} hljs` : 'hljs'}>
          {renderHighlightedCode(code, language, `${key}-code`)}
        </code>
      </pre>
    </ScrollArea>
  )
}

function renderBlockquoteChild(
  child: BlockLevelNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement | null {
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
  return null
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

function renderBlockquoteBlock(
  block: BlockquoteNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const content = block.content ?? []
  const children: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const child = content[i] as BlockLevelNode
    const rendered = renderBlockquoteChild(child, `${key}-${i}`, ctx)
    if (rendered !== null) children.push(rendered)
  }
  const calloutType = block.attrs?.calloutType
  if (calloutType) return renderCalloutBlock(calloutType, children, key)
  return (
    <blockquote key={key} className="border-l-[3px] border-border pl-4 text-muted-foreground">
      {children}
    </blockquote>
  )
}

function renderOrderedListBlock(
  block: OrderedListNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const content = block.content ?? []
  const items: React.ReactNode[] = []
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    const itemKey = `${key}-${i}`
    const liChildren: React.ReactNode[] = []
    const paragraphs = item?.content ?? []
    for (let j = 0; j < paragraphs.length; j++) {
      const p = paragraphs[j] as ParagraphNode | undefined
      if (p?.content) {
        liChildren.push(...renderInlineContent(p.content, `${itemKey}-${j}`, ctx))
      }
    }
    items.push(<li key={itemKey}>{liChildren}</li>)
  }
  return (
    <ol key={key} className="list-decimal list-inside">
      {items}
    </ol>
  )
}

function renderHorizontalRuleBlock(key: string): React.ReactElement {
  return <hr key={key} className="my-2 border-t border-border" data-testid="horizontal-rule" />
}

/**
 * Dispatch a block-level node to its sub-renderer. Paragraphs return an
 * array of inline elements (no wrapping <p>) to preserve legacy behavior;
 * every other block type returns a single React element.
 */
function renderBlock(
  block: BlockLevelNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement | React.ReactNode[] | null {
  switch (block.type) {
    case 'heading':
      return renderHeadingBlock(block, key, ctx)
    case 'codeBlock':
      return renderCodeBlock(block, key)
    case 'blockquote':
      return renderBlockquoteBlock(block, key, ctx)
    case 'orderedList':
      return renderOrderedListBlock(block, key, ctx)
    case 'horizontalRule':
      return renderHorizontalRuleBlock(key)
    case 'paragraph':
      return block.content ? renderInlineContent(block.content, key, ctx) : null
    default:
      return null
  }
}

/**
 * Render markdown content as rich React nodes for the static view.
 * Inline tokens (block_link, tag_ref) become styled/clickable spans.
 */
export function renderRichContent(
  markdown: string,
  options: {
    onNavigate?: ((id: string) => void) | undefined
    onTagClick?: ((id: string) => void) | undefined
    resolveBlockTitle?: ((id: string) => string | undefined) | undefined
    resolveTagName?: ((id: string) => string | undefined) | undefined
    resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
    resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
    interactive?: boolean | undefined
  },
): React.ReactNode {
  if (!markdown) return null
  const doc = parse(markdown) as DocNode
  if (!doc.content) return null

  const elements: React.ReactNode[] = []
  const ctx: RenderContext = options
  for (let bIdx = 0; bIdx < doc.content.length; bIdx++) {
    const block = doc.content[bIdx] as BlockLevelNode
    // Space separator between blocks
    if (bIdx > 0) {
      elements.push(<span key={`sep-${bIdx}`}> </span>)
    }
    const rendered = renderBlock(block, `b-${bIdx}`, ctx)
    if (Array.isArray(rendered)) {
      elements.push(...rendered)
    } else if (rendered !== null) {
      elements.push(rendered)
    }
  }

  return <>{elements}</>
}
