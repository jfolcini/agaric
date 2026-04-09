import { toHtml } from 'hast-util-to-html'
import { common, createLowlight } from 'lowlight'
import { AlertTriangle, Info, Lightbulb, StickyNote, XCircle } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense } from 'react'
import { parse } from '../editor/markdown-serializer'
import type { BlockLevelNode, DocNode, InlineNode } from '../editor/types'
import i18n from '../lib/i18n'
import { openUrl } from '../lib/open-url'
import { cn } from '../lib/utils'
import { ScrollArea } from './ui/scroll-area'
import { Spinner } from './ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// Lazy-load MermaidDiagram to avoid bundling mermaid on initial load
const LazyMermaidDiagram = lazy(() => import('./MermaidDiagram'))

const lowlight = createLowlight(common)

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

/**
 * Render markdown content as rich React nodes for the static view.
 * Inline tokens (block_link, tag_ref) become styled/clickable spans.
 */
export function renderRichContent(
  markdown: string,
  options: {
    onNavigate?: ((id: string) => void) | undefined
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
  let keyIdx = 0

  /** Render inline content nodes into React elements. */
  function renderInline(content: readonly InlineNode[]) {
    for (const node of content) {
      switch (node.type) {
        case 'text': {
          const linkMark = node.marks?.find((m) => m.type === 'link')
          const hasBold = node.marks?.some((m) => m.type === 'bold') ?? false
          const hasItalic = node.marks?.some((m) => m.type === 'italic') ?? false
          const hasCode = node.marks?.some((m) => m.type === 'code') ?? false

          // Build the text content, wrapping with mark elements
          let content: React.ReactNode =
            linkMark && linkMark.type === 'link' ? (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled via TipTap editor when block is focused
              // biome-ignore lint/a11y/noStaticElementInteractions: inline link within a button — parent handles focus/keyboard
              <span
                className="external-link cursor-pointer"
                data-testid="external-link"
                data-href={linkMark.attrs.href}
                onClick={(e) => {
                  e.stopPropagation()
                  openUrl(linkMark.attrs.href)
                }}
                {...(options.interactive
                  ? {
                      tabIndex: 0,
                      role: 'link' as const,
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          openUrl(linkMark.attrs.href)
                        }
                      },
                    }
                  : {})}
              >
                {node.text}
                <span className="sr-only"> {i18n.t('link.opensInNewTab')}</span>
                <span className="inline-block ml-0.5 text-[0.7em] opacity-60" aria-hidden="true">
                  ↗
                </span>
              </span>
            ) : (
              node.text
            )

          // Apply marks from innermost to outermost
          if (hasCode)
            content = (
              <code className="bg-muted rounded px-1 py-0.5 text-[0.85em] font-mono">
                {content}
              </code>
            )
          if (hasItalic) content = <em>{content}</em>
          if (hasBold) content = <strong>{content}</strong>

          elements.push(<span key={`t-${keyIdx++}`}>{content}</span>)
          break
        }

        case 'tag_ref': {
          const tagId = node.attrs.id
          const name = options.resolveTagName?.(tagId) ?? `#${tagId.slice(0, 8)}...`
          const status = options.resolveTagStatus?.(tagId) ?? 'active'
          elements.push(
            <span
              key={`tag-${keyIdx++}`}
              className={cn('tag-ref-chip', status === 'deleted' && 'tag-ref-deleted')}
              data-testid="tag-ref-chip"
              {...(status === 'deleted' ? { 'aria-label': `${name} (deleted)` } : {})}
              {...(options.interactive ? { tabIndex: 0 } : {})}
            >
              {name}
            </span>,
          )
          break
        }

        case 'block_link': {
          const linkId = node.attrs.id
          const title = options.resolveBlockTitle?.(linkId) ?? `[[${linkId.slice(0, 8)}...]]`
          const status = options.resolveBlockStatus?.(linkId) ?? 'active'
          elements.push(
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled via TipTap editor when block is focused
            // biome-ignore lint/a11y/noStaticElementInteractions: inline chip within a button — parent handles focus/keyboard
            <span
              key={`link-${keyIdx++}`}
              className={cn(
                'block-link-chip cursor-pointer',
                status === 'deleted' && 'block-link-deleted',
              )}
              data-testid="block-link-chip"
              {...(status === 'deleted' ? { 'aria-label': `${title} (deleted)` } : {})}
              onClick={(e) => {
                if (options.onNavigate) {
                  e.stopPropagation()
                  options.onNavigate(linkId)
                }
              }}
              {...(options.interactive
                ? {
                    tabIndex: 0,
                    role: 'link' as const,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (options.onNavigate) {
                          e.stopPropagation()
                          options.onNavigate(linkId)
                        }
                      }
                    },
                  }
                : {})}
            >
              {title}
            </span>,
          )
          break
        }

        case 'block_ref': {
          // Forward-looking: block_ref nodes rendered when parser emits ((ULID)) tokens
          const refNode = node as unknown as { attrs: { id: string } }
          const refId = refNode.attrs.id
          const fullContent = options.resolveBlockTitle?.(refId) ?? `(( ${refId.slice(0, 8)}... ))`
          const status = options.resolveBlockStatus?.(refId) ?? 'active'
          // Show first line, truncated to 60 chars, for the chip label
          const firstLine = fullContent.split('\n')[0] ?? fullContent
          const chipLabel = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
          elements.push(
            <Tooltip key={`bref-${keyIdx++}`}>
              <TooltipTrigger asChild>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: role is spread dynamically via interactive option */}
                <span
                  className={cn(
                    'block-ref-chip cursor-pointer',
                    status === 'deleted' && 'block-ref-deleted',
                  )}
                  data-testid="block-ref-chip"
                  {...(status === 'deleted' ? { 'aria-label': `${chipLabel} (deleted)` } : {})}
                  onClick={(e) => {
                    if (options.onNavigate) {
                      e.stopPropagation()
                      options.onNavigate(refId)
                    }
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && options.onNavigate) {
                      e.preventDefault()
                      e.stopPropagation()
                      options.onNavigate(refId)
                    }
                  }}
                  {...(options.interactive
                    ? { tabIndex: 0, role: 'link' }
                    : { role: 'button', tabIndex: 0 })}
                >
                  {chipLabel}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
                {fullContent.length > 300 ? `${fullContent.slice(0, 297)}...` : fullContent}
              </TooltipContent>
            </Tooltip>,
          )
          break
        }

        case 'hardBreak':
          elements.push(<span key={`br-${keyIdx++}`}> </span>)
          break

        default:
          break
      }
    }
  }

  for (let bIdx = 0; bIdx < doc.content.length; bIdx++) {
    const block = doc.content[bIdx] as BlockLevelNode
    // Space separator between blocks
    if (bIdx > 0) {
      elements.push(<span key={`sep-${keyIdx++}`}> </span>)
    }

    if (block.type === 'heading') {
      const HeadingTag = `h${block.attrs.level}` as keyof JSX.IntrinsicElements
      const headingClasses: Record<number, string> = {
        1: 'text-xl sm:text-2xl font-bold',
        2: 'text-lg sm:text-xl font-bold',
        3: 'text-base sm:text-lg font-semibold',
        4: 'text-sm sm:text-base font-semibold',
        5: 'text-sm font-semibold',
        6: 'text-xs font-semibold uppercase tracking-wide',
      }
      const cls = headingClasses[block.attrs.level] ?? ''
      const startIdx = keyIdx++
      const inlineElements: React.ReactNode[] = []
      if (block.content) {
        const prevLen = elements.length
        renderInline(block.content)
        inlineElements.push(...elements.splice(prevLen))
      }
      elements.push(
        <HeadingTag key={`h-${startIdx}`} className={cls}>
          {inlineElements}
        </HeadingTag>,
      )
    } else if (block.type === 'codeBlock') {
      const code = block.content?.[0]?.text ?? ''
      const language = block.attrs?.language ?? ''
      if (language === 'mermaid') {
        elements.push(
          <Suspense
            key={`mermaid-${keyIdx++}`}
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
          </Suspense>,
        )
      } else {
        let highlighted: string
        try {
          const tree = language ? lowlight.highlight(language, code) : lowlight.highlightAuto(code)
          highlighted = toHtml(tree)
        } catch {
          highlighted = code
        }
        elements.push(
          <ScrollArea key={`code-${keyIdx++}`} className="bg-muted rounded-md text-sm font-mono">
            <pre className="px-3 py-2">
              <code
                className={language ? `language-${language} hljs` : 'hljs'}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: lowlight output is safe
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            </pre>
          </ScrollArea>,
        )
      }
    } else if (block.type === 'blockquote') {
      const calloutType = block.attrs?.calloutType
      const calloutConfig = calloutType
        ? (CALLOUT_CONFIG[calloutType] ?? CALLOUT_CONFIG.note)
        : null
      const bqKey = `bq-${keyIdx++}`
      const bqChildren: React.ReactNode[] = []
      for (let ci = 0; ci < (block.content?.length ?? 0); ci++) {
        const child = (block.content as BlockLevelNode[])[ci] as BlockLevelNode
        const childKey = `${bqKey}-${ci}`
        if (child.type === 'paragraph' && child.content) {
          const prevLen = elements.length
          renderInline(child.content as readonly InlineNode[])
          const inlined = elements.splice(prevLen)
          bqChildren.push(<p key={childKey}>{inlined}</p>)
        } else if (child.type === 'heading') {
          const HTag = `h${child.attrs.level}` as keyof JSX.IntrinsicElements
          const hClasses: Record<number, string> = {
            1: 'text-xl sm:text-2xl font-bold',
            2: 'text-lg sm:text-xl font-bold',
            3: 'text-base sm:text-lg font-semibold',
            4: 'text-sm sm:text-base font-semibold',
            5: 'text-sm font-semibold',
            6: 'text-xs font-semibold uppercase tracking-wide',
          }
          const hCls = hClasses[child.attrs.level] ?? ''
          const prevLen = elements.length
          if (child.content) renderInline(child.content as readonly InlineNode[])
          const hInlined = elements.splice(prevLen)
          bqChildren.push(
            <HTag key={childKey} className={hCls}>
              {hInlined}
            </HTag>,
          )
        }
      }
      if (calloutConfig) {
        const CalloutIcon = calloutConfig.icon
        elements.push(
          <blockquote
            key={bqKey}
            className={cn(
              'border-l-[3px] pl-4 py-2 rounded-r-md',
              calloutConfig.borderClass,
              calloutConfig.bgClass,
            )}
            data-callout-type={calloutType}
            data-testid="callout-block"
          >
            <div
              className={cn(
                'flex items-center gap-1.5 font-semibold text-sm mb-1',
                calloutConfig.textClass,
              )}
            >
              <CalloutIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{calloutConfig.label}</span>
            </div>
            <div className="text-foreground">{bqChildren}</div>
          </blockquote>,
        )
      } else {
        elements.push(
          <blockquote
            key={bqKey}
            className="border-l-[3px] border-border pl-4 text-muted-foreground"
          >
            {bqChildren}
          </blockquote>,
        )
      }
    } else if (block.type === 'orderedList') {
      const olKey = `ol-${keyIdx++}`
      const olItems: React.ReactNode[] = []
      for (let ci = 0; ci < (block.content?.length ?? 0); ci++) {
        const item = (
          block.content as unknown as {
            content?: { type: 'paragraph'; content?: readonly InlineNode[] }[]
          }[]
        )[ci]
        const itemKey = `${olKey}-${ci}`
        const liChildren: React.ReactNode[] = []
        if (item?.content) {
          for (const p of item.content) {
            if (p.content) {
              const prevLen = elements.length
              renderInline(p.content as readonly InlineNode[])
              liChildren.push(...elements.splice(prevLen))
            }
          }
        }
        olItems.push(<li key={itemKey}>{liChildren}</li>)
      }
      elements.push(
        <ol key={olKey} className="list-decimal list-inside">
          {olItems}
        </ol>,
      )
    } else if (block.type === 'horizontalRule') {
      elements.push(
        <hr
          key={`hr-${keyIdx++}`}
          className="my-2 border-t border-border"
          data-testid="horizontal-rule"
        />,
      )
    } else {
      // paragraph
      if (!block.content) continue
      renderInline(block.content as readonly InlineNode[])
    }
  }

  return <>{elements}</>
}
