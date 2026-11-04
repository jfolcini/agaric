import type React from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FootnoteRefNode, ParagraphNode } from '@/editor/types'
import { i18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * A footnote reference `[^label]` (#6033): its number on the page, which
 * focuses the label's definition when clicked, or, muted, a reference whose
 * label nothing on the page defines. With no page to number it (`ctx.footnotes`
 * unset: a search hit, a history row), the label as written.
 */
export function renderFootnoteRef(
  node: FootnoteRefNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  const { label } = node.attrs
  if (ctx.footnotes === undefined) {
    return (
      <sup key={key} className="footnote-ref" data-testid="footnote-ref">
        {label}
      </sup>
    )
  }
  const number = ctx.footnotes.numbers.get(label) ?? label
  const definition = ctx.footnotes.definitions.get(label)
  if (definition === undefined) {
    const missing = i18n.t('editor.footnoteMissing')
    return (
      <Tooltip key={key}>
        <TooltipTrigger asChild>
          <sup
            className={cn(
              'footnote-ref footnote-ref-missing',
              ctx.interactive === true && 'focus-ring-visible',
            )}
            data-testid="footnote-ref"
            {...(ctx.interactive === true ? { tabIndex: 0 } : {})}
          >
            {number}
            <span className="sr-only"> {missing}</span>
          </sup>
        </TooltipTrigger>
        <TooltipContent>{missing}</TooltipContent>
      </Tooltip>
    )
  }
  const onNavigate = ctx.interactive === true ? ctx.onNavigate : undefined
  const go = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onNavigate?.(definition)
  }
  return (
    <sup
      key={key}
      className={cn(
        'footnote-ref',
        onNavigate !== undefined && 'cursor-pointer focus-ring-visible touch-hit-area',
      )}
      data-testid="footnote-ref"
      {...(onNavigate === undefined
        ? {}
        : {
            role: 'link',
            tabIndex: 0,
            'aria-label': i18n.t('editor.footnoteLink', { number }),
            onClick: go,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') go(e)
            },
          })}
    >
      {number}
    </sup>
  )
}

/**
 * A definition block's `[^label]: ` prefix (`definedLabel`), as a small marker
 * with the label's number.
 */
export function renderFootnoteDefinition(label: string, ctx: RenderContext): React.ReactElement {
  return (
    <sup
      key="footnote-definition"
      className="footnote-definition"
      data-testid="footnote-definition"
    >
      {ctx.footnotes?.numbers.get(label) ?? label}
    </sup>
  )
}

/** A definition block's first paragraph without its `[^label]: ` prefix. */
export function withoutDefinitionPrefix(block: ParagraphNode): ParagraphNode {
  const [, prefix, ...rest] = block.content ?? []
  if (prefix?.type !== 'text') return block
  const text = prefix.text.slice(': '.length)
  return { ...block, content: text === '' ? rest : [{ ...prefix, text }, ...rest] }
}
