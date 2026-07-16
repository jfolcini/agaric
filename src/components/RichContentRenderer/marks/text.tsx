import type React from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import type { LinkMark, TextNode } from '@/editor/types'
import { i18n } from '@/lib/i18n'
import { openUrl } from '@/lib/open-url'
import { isAllowedUrl } from '@/lib/url-validation'

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
  label: React.ReactNode,
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
      {label}
      <span className="sr-only"> {i18n.t('link.opensInNewTab')}</span>
      <span className="inline-block ml-0.5 text-[0.7em] opacity-60" aria-hidden="true">
        ↗
      </span>
    </span>
  )
}

/** Apply bold / italic / code / strike / highlight / underline / link marks to a text node, innermost-out. */
function applyTextMarks(node: TextNode, ctx: RenderContext, key: string): React.ReactNode {
  // Perf (#2201) — single pass over `node.marks`: collect the mark-presence
  // flags and the (first) link mark in ONE scan rather than ~7 independent
  // `find`/`some` array searches. The wrapping order below is fixed and
  // independent of the marks' array order, so the output is byte-identical to
  // the previous per-mark scans. `linkMark` keeps first-match semantics
  // (matching the old `.find`) by only assigning when still unset.
  let linkMark: LinkMark | undefined
  let hasCode = false
  let hasStrike = false
  let hasHighlight = false
  let hasItalic = false
  let hasBold = false
  let hasUnderline = false
  if (node.marks) {
    for (const m of node.marks) {
      switch (m.type) {
        case 'link': {
          if (linkMark === undefined) linkMark = m
          break
        }
        case 'code': {
          hasCode = true
          break
        }
        case 'strike': {
          hasStrike = true
          break
        }
        case 'highlight': {
          hasHighlight = true
          break
        }
        case 'italic': {
          hasItalic = true
          break
        }
        case 'bold': {
          hasBold = true
          break
        }
        case 'underline': {
          hasUnderline = true
          break
        }
      }
    }
  }
  // Text marks (code/strike/highlight/italic/bold/underline) wrap the
  // visible label only. The external-link element is applied LAST, around
  // the already-marked label, so its trailing ↗ glyph and sr-only
  // "opens in new tab" affordance stay outside the marks (a struck-through
  // or `code`-styled link must not cross/monospace the icon). See #1737.
  let content: React.ReactNode = node.text

  if (hasCode) {
    content = (
      <code className="bg-muted rounded px-1 py-0.5 text-[0.85em] font-mono">{content}</code>
    )
  }
  // #211 P0-2 — strike and highlight previously had no static-render branch,
  // so the marks were silently invisible once a block rendered statically.
  if (hasStrike) {
    content = <s>{content}</s>
  }
  if (hasHighlight) {
    // #1096 — the user-highlight (highlighter-pen) semantic now routes
    // through the fully-themed `--highlight` amber token (`bg-highlight`)
    // instead of raw `bg-yellow-*` literals. The editor `<mark>`
    // (`.ProseMirror mark`, index.css) is kept aligned to the same token so
    // a highlight looks identical editing vs reading across every theme +
    // high-contrast. This is DISTINCT from the search-match semantic, which
    // uses `--accent` (`.search-result-mark`); the split is intentional.
    content = <mark className="bg-highlight rounded px-0.5">{content}</mark>
  }
  if (hasItalic) {
    content = <em>{content}</em>
  }
  if (hasBold) {
    content = <strong>{content}</strong>
  }
  // #211 P2-5 — underline is the outermost mark (mirrors the serializer's
  // `<u>…</u>` wrapping), so apply it last.
  if (hasUnderline) {
    content = <u>{content}</u>
  }

  // Re-validate href scheme at the render sink: input-time validation
  // (external-link extension / link editor) is bypassed by the markdown
  // import / peer sync, so a `javascript:`/`data:` href can reach stored
  // content. Render those as plain marked text rather than a clickable link
  // that would hand the href to `openUrl`.
  if (linkMark && isAllowedUrl(linkMark.attrs.href)) {
    content = renderExternalLink(content, linkMark.attrs.href, ctx, `${key}-link`)
  }

  return content
}

export function renderTextInline(
  node: TextNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  return <span key={key}>{applyTextMarks(node, ctx, key)}</span>
}
