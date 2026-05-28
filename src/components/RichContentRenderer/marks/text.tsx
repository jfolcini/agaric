import type React from 'react'

import type { TextNode } from '../../../editor/types'
import { i18n } from '../../../lib/i18n'
import { openUrl } from '../../../lib/open-url'
import { isAllowedUrl } from '../../../lib/url-validation'
import type { RenderContext } from '../context'

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
  // Re-validate the href scheme at the render sink: input-time validation
  // (external-link extension / link editor) is bypassed by markdown import
  // and peer sync, so a `javascript:`/`data:` href can reach stored content.
  // Render those as plain text rather than a clickable link to `openUrl`.
  let content: React.ReactNode =
    linkMark && linkMark.type === 'link' && isAllowedUrl(linkMark.attrs.href)
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

export function renderTextInline(
  node: TextNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  return <span key={key}>{applyTextMarks(node, ctx, key)}</span>
}
