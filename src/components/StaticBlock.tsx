/**
 * StaticBlock — renders a non-focused block as a plain div.
 *
 * Clicking focuses the block, which mounts the TipTap editor.
 * This is the "static div for all non-focused blocks" from the roving editor pattern.
 *
 * Inline tokens (block_link, tag_ref) are rendered as styled spans
 * with optional click-to-navigate (block links) and deleted decoration.
 */

import { convertFileSrc } from '@tauri-apps/api/core'
import { toHtml } from 'hast-util-to-html'
import { common, createLowlight } from 'lowlight'
import {
  AlertTriangle,
  File,
  FileText,
  Image as ImageIcon,
  Info,
  Lightbulb,
  StickyNote,
  XCircle,
} from 'lucide-react'
import type React from 'react'
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parse } from '../editor/markdown-serializer'
import type { BlockLevelNode, DocNode, InlineNode } from '../editor/types'
import { useBlockAttachments } from '../hooks/useBlockAttachments'
import i18n from '../lib/i18n'
import { openUrl } from '../lib/open-url'
import { getProperties, setProperty } from '../lib/tauri'
import { cn } from '../lib/utils'
import { ImageLightbox } from './ImageLightbox'
import { QueryResult } from './QueryResult'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Spinner } from './ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// Lazy-load PdfViewerDialog to avoid bundling pdfjs-dist on initial load
const LazyPdfViewerDialog = lazy(() =>
  import('./PdfViewerDialog').then((m) => ({ default: m.PdfViewerDialog })),
)

const lowlight = createLowlight(common)

/** Callout type configuration: border color, icon, and label. */
const CALLOUT_CONFIG: Record<
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
    borderClass: 'border-blue-500',
    bgClass: 'bg-blue-50 dark:bg-blue-950/30',
    textClass: 'text-blue-700 dark:text-blue-400',
    icon: Info,
    label: 'Info',
  },
  warning: {
    borderClass: 'border-amber-500',
    bgClass: 'bg-amber-50 dark:bg-amber-950/30',
    textClass: 'text-amber-700 dark:text-amber-400',
    icon: AlertTriangle,
    label: 'Warning',
  },
  tip: {
    borderClass: 'border-green-500',
    bgClass: 'bg-green-50 dark:bg-green-950/30',
    textClass: 'text-green-700 dark:text-green-400',
    icon: Lightbulb,
    label: 'Tip',
  },
  error: {
    borderClass: 'border-red-500',
    bgClass: 'bg-red-50 dark:bg-red-950/30',
    textClass: 'text-red-700 dark:text-red-400',
    icon: XCircle,
    label: 'Error',
  },
  note: {
    borderClass: 'border-gray-500',
    bgClass: 'bg-gray-50 dark:bg-gray-950/30',
    textClass: 'text-gray-700 dark:text-gray-400',
    icon: StickyNote,
    label: 'Note',
  },
}

/**
 * Convert a local filesystem path to a Tauri asset protocol URL.
 * Returns null when not running inside the Tauri runtime (browser dev mode, tests).
 */
export function getAssetUrl(fsPath: string): string | null {
  try {
    if (
      typeof window !== 'undefined' &&
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    ) {
      return convertFileSrc(fsPath)
    }
  } catch {
    // Not in Tauri environment
  }
  return null
}

/** Format bytes into a human-readable size string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Return the appropriate Lucide icon for a MIME type (used in attachment chips). */
function AttachmentMimeIcon({ mimeType }: { mimeType: string }): React.ReactElement {
  if (mimeType.startsWith('image/')) {
    return <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  if (mimeType.startsWith('text/')) {
    return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  return <File className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
}

/** Width presets for image resize controls. */
const IMAGE_WIDTH_PRESETS = [
  { label: 'imageResize.small', value: '25' },
  { label: 'imageResize.medium', value: '50' },
  { label: 'imageResize.large', value: '75' },
  { label: 'imageResize.full', value: '100' },
] as const

/** Floating toolbar for resizing images via width presets. */
function ImageResizeToolbar({
  blockId,
  currentWidth,
  onWidthChange,
}: {
  blockId: string
  currentWidth: string
  onWidthChange: (width: string) => void
}): React.ReactElement {
  const { t } = useTranslation()

  const handleClick = useCallback(
    (value: string) => {
      onWidthChange(value)
      setProperty({
        blockId,
        key: 'image_width',
        valueText: value,
      }).catch(() => {
        // Revert on failure — restore previous width
        onWidthChange(currentWidth)
      })
    },
    [blockId, currentWidth, onWidthChange],
  )

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-10 flex items-center gap-1 rounded-full bg-popover border border-border shadow-md px-2 py-1"
      role="toolbar"
      aria-label={t('imageResize.toolbar')}
      data-testid="image-resize-toolbar"
    >
      {IMAGE_WIDTH_PRESETS.map((preset) => (
        <Button
          key={preset.value}
          variant={currentWidth === preset.value ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={t(preset.label)}
          onClick={(e) => {
            e.stopPropagation()
            handleClick(preset.value)
          }}
          data-testid={`image-resize-${preset.value}`}
        >
          {`${preset.value}%`}
        </Button>
      ))}
    </div>
  )
}

export interface StaticBlockProps {
  blockId: string
  content: string
  onFocus: (blockId: string) => void
  /** Called when the user clicks a block-link chip. */
  onNavigate?: ((id: string) => void) | undefined
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Resolve a tag ULID → display name. */
  resolveTagName?: ((id: string) => string) | undefined
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
  /** Ctrl+Click / Shift+Click selection callback. */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
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
    } else {
      // paragraph
      if (!block.content) continue
      renderInline(block.content as readonly InlineNode[])
    }
  }

  return <>{elements}</>
}

function StaticBlockInner({
  blockId,
  content,
  onFocus,
  onNavigate,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  isSelected,
  onSelect,
}: StaticBlockProps): React.ReactElement {
  const { t } = useTranslation()
  // Keep callback refs so the expensive useMemo only re-runs when `content` changes.
  // Callbacks don't affect the rendered output — they only affect click behaviour —
  // so they can safely live in refs that are read at call-time.
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  resolveBlockTitleRef.current = resolveBlockTitle
  const resolveTagNameRef = useRef(resolveTagName)
  resolveTagNameRef.current = resolveTagName
  const resolveBlockStatusRef = useRef(resolveBlockStatus)
  resolveBlockStatusRef.current = resolveBlockStatus
  const resolveTagStatusRef = useRef(resolveTagStatus)
  resolveTagStatusRef.current = resolveTagStatus

  const richContent = useMemo(
    () =>
      content
        ? renderRichContent(content, {
            onNavigate: onNavigate ? (id: string) => onNavigateRef.current?.(id) : undefined,
            resolveBlockTitle: (id) => resolveBlockTitleRef.current?.(id),
            resolveTagName: (id) => resolveTagNameRef.current?.(id),
            resolveBlockStatus: (id) => resolveBlockStatusRef.current?.(id) ?? 'active',
            resolveTagStatus: (id) => resolveTagStatusRef.current?.(id) ?? 'active',
          })
        : null,
    [content, onNavigate],
  )

  const { attachments, loading: attachmentsLoading } = useBlockAttachments(blockId)

  // PDF viewer dialog state
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false)
  const [pdfViewerUrl, setPdfViewerUrl] = useState('')
  const [pdfViewerFilename, setPdfViewerFilename] = useState('')

  // Image lightbox state
  const [lightboxImage, setLightboxImage] = useState<{
    src: string
    alt: string
    fsPath: string
  } | null>(null)

  // Image resize state
  const [imageWidth, setImageWidth] = useState('100')
  const [imageHovered, setImageHovered] = useState(false)

  // Only fetch image_width property when the block has image attachments
  const hasImageAttachments =
    !attachmentsLoading && attachments.some((a) => a.mime_type.startsWith('image/'))

  // Load stored image_width property when image attachments are present
  useEffect(() => {
    if (!hasImageAttachments) return
    let cancelled = false
    getProperties(blockId)
      .then((props) => {
        if (cancelled) return
        const widthProp = props.find((p) => p.key === 'image_width')
        if (widthProp?.value_text) {
          setImageWidth(widthProp.value_text)
        }
      })
      .catch(() => {
        // Ignore — use default width
      })
    return () => {
      cancelled = true
    }
  }, [blockId, hasImageAttachments])

  // Detect {{query ...}} blocks and render QueryResult instead of the text
  if (content?.startsWith('{{query ') && content.endsWith('}}')) {
    const expression = content.slice(8, -2).trim()
    return (
      <button
        type="button"
        className="block-static w-full min-h-[1.75rem] rounded-md text-left text-sm"
        data-testid="block-static"
        data-block-id={blockId}
        onClick={() => onFocus(blockId)}
      >
        <QueryResult
          expression={expression}
          onNavigate={onNavigate ? (pageId) => onNavigate(pageId) : undefined}
          resolveBlockTitle={resolveBlockTitle}
        />
      </button>
    )
  }

  const hasAttachments = !attachmentsLoading && attachments.length > 0

  return (
    <>
      <button
        type="button"
        className={cn(
          'block-static w-full min-h-[1.75rem] cursor-text rounded-md px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [@media(pointer:coarse)]:min-h-[2.75rem]',
          isSelected && 'ring-2 ring-primary/50 bg-primary/5',
        )}
        data-testid="block-static"
        data-block-id={blockId}
        aria-label={t('block.editLabel')}
        onClick={(e) => {
          if ((e.ctrlKey || e.metaKey) && onSelect) {
            e.preventDefault()
            onSelect(blockId, 'toggle')
          } else if (e.shiftKey && onSelect) {
            e.preventDefault()
            onSelect(blockId, 'range')
          } else {
            onFocus(blockId)
          }
        }}
      >
        {richContent ?? (
          <span className="block-placeholder text-muted-foreground italic">
            {t('block.emptyPlaceholder')}
          </span>
        )}
      </button>
      {hasAttachments && (
        <div className="mt-1 flex flex-wrap gap-2 px-3 pb-1" data-testid="attachment-section">
          {attachments.map((att) => {
            if (att.mime_type.startsWith('image/')) {
              const url = getAssetUrl(att.fs_path)
              if (!url) return null
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus interaction for image resize toolbar
                <div
                  key={att.id}
                  className="relative inline-block"
                  style={{ maxWidth: `${imageWidth}%` }}
                  data-testid="image-resize-wrapper"
                  onMouseEnter={() => setImageHovered(true)}
                  onMouseLeave={() => setImageHovered(false)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setImageHovered((prev) => !prev)
                    }
                  }}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: image container needs focus for keyboard resize access
                  tabIndex={0}
                  onFocus={() => setImageHovered(true)}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                      setImageHovered(false)
                    }
                  }}
                >
                  {imageHovered && (
                    <ImageResizeToolbar
                      blockId={blockId}
                      currentWidth={imageWidth}
                      onWidthChange={setImageWidth}
                    />
                  )}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: image open action is supplementary */}
                  <img
                    src={url}
                    alt={att.filename}
                    loading="lazy"
                    className="rounded-md cursor-pointer hover:opacity-90 transition-opacity"
                    style={{ maxWidth: '100%', maxHeight: '400px', objectFit: 'contain' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setLightboxImage({ src: url, alt: att.filename, fsPath: att.fs_path })
                    }}
                  />
                </div>
              )
            }
            return (
              <button
                key={att.id}
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 active:bg-accent/70 hover:text-foreground"
                aria-label={`Open file ${att.filename}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (att.mime_type === 'application/pdf') {
                    const url = getAssetUrl(att.fs_path)
                    if (url) {
                      setPdfViewerUrl(url)
                      setPdfViewerFilename(att.filename)
                      setPdfViewerOpen(true)
                    } else {
                      openUrl(att.fs_path)
                    }
                  } else {
                    openUrl(att.fs_path)
                  }
                }}
              >
                <AttachmentMimeIcon mimeType={att.mime_type} />
                <span className="truncate max-w-[200px]">{att.filename}</span>
                <span className="shrink-0 opacity-70">{formatSize(att.size_bytes)}</span>
              </button>
            )
          })}
        </div>
      )}
      <Suspense fallback={<Spinner />}>
        <LazyPdfViewerDialog
          open={pdfViewerOpen}
          onOpenChange={setPdfViewerOpen}
          fileUrl={pdfViewerUrl}
          filename={pdfViewerFilename}
        />
      </Suspense>
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          open={!!lightboxImage}
          onOpenChange={(open) => {
            if (!open) setLightboxImage(null)
          }}
          onOpenExternal={() => openUrl(lightboxImage.fsPath)}
        />
      )}
    </>
  )
}

export const StaticBlock = memo(StaticBlockInner)
StaticBlock.displayName = 'StaticBlock'
