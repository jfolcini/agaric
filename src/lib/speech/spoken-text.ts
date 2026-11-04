/**
 * The text *Read aloud* speaks for a run of blocks (#5745): what the static renderer shows,
 * as words. Pure — the caller passes the blocks in tree order, the resolvers its
 * `RenderContext` uses, and `t`.
 *
 * - Marks are dropped; an external link speaks its label, an image its alt text.
 * - Page links, tags and block refs speak the title the chip shows. One the resolver has
 *   nothing for speaks a "missing" word, never the id prefix the chip falls back to.
 * - Code blocks, display and inline math, Mermaid diagrams, embeds and query blocks are named
 *   once and skipped.
 * - Property lines are skipped (priority, due and scheduled are properties too, so they are
 *   never in `content`); the task state is spoken first, as its word.
 * - Ordered lists speak their numbers as the renderer shows them; table cells are read row by
 *   row.
 */

import { parse } from '@/editor/markdown-serializer'
import type { BlockLevelNode, InlineNode, ListItemNode, TableNode } from '@/editor/types'
import type { BlockRow } from '@/lib/bindings'
import { unresolvedBlockLabel, unresolvedTagLabel } from '@/lib/block-title'
import { parseEmbedToken } from '@/lib/embed-token'
import { parseImageAlt } from '@/lib/image-alt-size'
import { parseInlineProperties, stripPropertyLines } from '@/lib/inline-property-parse'
import { getPageDisplayName } from '@/lib/page-display'
import { isTodoState } from '@/lib/task-states'

/**
 * The longest text one utterance may carry: Android's `getMaxSpeechInputLength()`. Counted in
 * UTF-16 code units, as JavaScript's `length` and Android's `CharSequence.length()` both count.
 */
export const MAX_UTTERANCE_CHARS = 4000

export interface SpokenUtterance {
  readonly blockId: string
  readonly text: string
}

/**
 * The resolve store's lookups, as `RenderContext` carries them. A miss comes back as `undefined`
 * or as the chip's unresolved label.
 */
export interface SpokenTextResolvers {
  readonly resolveBlockTitle: (id: string) => string | undefined
  readonly resolveTagName: (id: string) => string | undefined
}

export type SpokenBlock = Pick<BlockRow, 'id' | 'content' | 'todo_state'>

type Translate = (key: string) => string

interface SpeakContext {
  readonly resolvers: SpokenTextResolvers
  readonly t: Translate
}

/** One or more utterances per block that has anything to say, in the order given. */
export function spokenUtterances(
  blocks: readonly SpokenBlock[],
  resolvers: SpokenTextResolvers,
  t: Translate,
): SpokenUtterance[] {
  const ctx = { resolvers, t }
  return blocks.flatMap((block) =>
    splitUtteranceText(spokenBlockText(block, ctx)).map((text) => ({ blockId: block.id, text })),
  )
}

function spokenBlockText(block: SpokenBlock, ctx: SpeakContext): string {
  const body = block.content === null ? '' : spokenContent(block.content, ctx)
  if (!isTodoState(block.todo_state)) return body
  const state = ctx.t(`block.taskState.${block.todo_state.toLowerCase()}`)
  return body === '' ? state : `${state}: ${body}`
}

function spokenContent(content: string, ctx: SpeakContext): string {
  // The same whole-block sniffs `StaticBlock` renders a widget for.
  if (parseEmbedToken(content) !== null) return ctx.t('readAloud.embed')
  if (content.startsWith('{{query ') && content.endsWith('}}')) return ctx.t('readAloud.query')
  const propertyLines = new Set(parseInlineProperties(content).map((line) => line.lineIndex))
  const doc = parse(stripPropertyLines(content, propertyLines))
  return (doc.content ?? [])
    .flatMap((node) => blockLines(node, ctx))
    .filter((line) => line.trim() !== '')
    .join('\n')
}

function blockLines(node: BlockLevelNode, ctx: SpeakContext): string[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      return [inlineText(node.content, ctx)]
    }
    case 'codeBlock': {
      return [
        ctx.t(node.attrs?.language === 'mermaid' ? 'readAloud.diagram' : 'readAloud.codeBlock'),
      ]
    }
    case 'math_block': {
      return [ctx.t('readAloud.formula')]
    }
    case 'horizontalRule': {
      return []
    }
    case 'blockquote': {
      return (node.content ?? []).flatMap((child) => blockLines(child, ctx))
    }
    case 'bulletList': {
      return (node.content ?? []).flatMap((item) => listItemLines(item, ctx))
    }
    case 'orderedList': {
      return (node.content ?? []).flatMap((item, index) => {
        const lines = listItemLines(item, ctx)
        lines[0] = `${index + 1}. ${lines[0] ?? ''}`
        return lines
      })
    }
    case 'table': {
      return tableLines(node, ctx)
    }
  }
}

function listItemLines(item: ListItemNode, ctx: SpeakContext): string[] {
  return (item.content ?? []).flatMap((child) => blockLines(child, ctx))
}

function tableLines(table: TableNode, ctx: SpeakContext): string[] {
  return (table.content ?? []).map((row) =>
    (row.content ?? [])
      .map((cell) => (cell.content ?? []).map((p) => inlineText(p.content, ctx)).join(' '))
      .join(', '),
  )
}

function inlineText(nodes: readonly InlineNode[] | undefined, ctx: SpeakContext): string {
  return (nodes ?? []).map((node) => inlineNodeText(node, ctx)).join('')
}

function inlineNodeText(node: InlineNode, ctx: SpeakContext): string {
  const { resolvers, t } = ctx
  switch (node.type) {
    case 'text': {
      return node.text
    }
    case 'hardBreak': {
      return '\n'
    }
    case 'image': {
      return parseImageAlt(node.attrs.alt).text
    }
    case 'math_inline': {
      return t('readAloud.formula')
    }
    case 'tag_ref': {
      const name = resolvers.resolveTagName(node.attrs.id)
      return name === undefined || name === unresolvedTagLabel(node.attrs.id)
        ? t('readAloud.missingTag')
        : name
    }
    case 'block_link': {
      if (node.attrs.label !== undefined) return node.attrs.label
      const title = resolvedBlockTitle(node.attrs.id, resolvers)
      return title === null ? t('readAloud.missingPage') : getPageDisplayName(title, 'leaf').label
    }
    case 'block_ref': {
      return resolvedBlockTitle(node.attrs.id, resolvers) ?? t('readAloud.missingBlock')
    }
    case 'footnote_ref': {
      return ''
    }
  }
}

/** The resolver's title, or `null` where the chip would show its unresolved label. */
function resolvedBlockTitle(id: string, resolvers: SpokenTextResolvers): string | null {
  const title = resolvers.resolveBlockTitle(id)
  return title === undefined || title === unresolvedBlockLabel(id) ? null : title
}

/** A sentence end followed by whitespace, or a line break. */
const SENTENCE_BREAK = /[.!?…]\s|\n/g
const WORD_BREAK = /\s/g

/**
 * `text` in chunks of at most `maxChars` UTF-16 code units whose concatenation is exactly
 * `text`. Each cut falls after the last sentence end in reach, else after the last whitespace,
 * else at `maxChars`, moved back one unit rather than separate a surrogate pair. Empty text has
 * no chunks.
 */
export function splitUtteranceText(text: string, maxChars = MAX_UTTERANCE_CHARS): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const cut =
      lastBreakEnd(window, SENTENCE_BREAK) ||
      lastBreakEnd(window, WORD_BREAK) ||
      hardCut(rest, maxChars)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Where the last match of `pattern` in `window` ends, or 0 when there is none. */
function lastBreakEnd(window: string, pattern: RegExp): number {
  let end = 0
  for (const match of window.matchAll(pattern)) end = match.index + match[0].length
  return end
}

function hardCut(text: string, maxChars: number): number {
  const last = text.charCodeAt(maxChars - 1)
  return last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars
}
