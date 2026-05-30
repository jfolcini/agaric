/**
 * Structural slash commands — anything that changes the block's content
 * structure: headings, callouts, code/quote blocks, lists, dividers,
 * tables, link/tag/query inserts.
 *
 * Heading commands (`h1`..`h6`) match a regex outside the prefix table —
 * we expose them here as a single prefix entry whose handler parses the
 * level off `item.id`. This keeps the dispatcher walk uniform across all
 * sub-hooks.
 */

import { useMemo } from 'react'

import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'

import { applyContentEdit, readCurrentContent } from './helpers'
import type { SlashCommandContext, SlashHandlerTables } from './types'

async function handleHeading(ctx: SlashCommandContext, level: number): Promise<void> {
  const stripped = readCurrentContent(ctx).replace(/^#{1,6}\s/, '')
  const newContent = `${'#'.repeat(level)} ${stripped}`
  await applyContentEdit(ctx, newContent, 'blockTree.setHeadingFailed')
}

async function handleCallout(ctx: SlashCommandContext, calloutType: string): Promise<void> {
  const newContent = `> [!${calloutType.toUpperCase()}] ${readCurrentContent(ctx)}`
  await applyContentEdit(ctx, newContent, 'slash.calloutFailed')
}

async function handleNumberedList(ctx: SlashCommandContext): Promise<void> {
  const newContent = `1. ${readCurrentContent(ctx)}`
  await applyContentEdit(ctx, newContent, 'slash.numberedListFailed')
}

async function handleDivider(ctx: SlashCommandContext): Promise<void> {
  await applyContentEdit(ctx, '---', 'slash.dividerFailed')
}

function handleTable(ctx: SlashCommandContext, id: string, withHeaderRow = true): void {
  let rows = 3
  let cols = 3
  // Accept dimensions from either `table:N:M` or `table-no-header:N:M`.
  const dimMatch = id.match(/^table(?:-no-header)?:(\d+):(\d+)$/)
  if (dimMatch) {
    rows = Number.parseInt(dimMatch[1] as string, 10)
    cols = Number.parseInt(dimMatch[2] as string, 10)
  }
  ctx.rovingEditor.editor?.chain().focus().insertTable({ rows, cols, withHeaderRow }).run()
}

export function useSlashCommandStructural(): SlashHandlerTables {
  return useMemo<SlashHandlerTables>(() => {
    // h1..h6 — six exact entries beat carrying a regex through the dispatch
    // table. Keeps `SlashHandlerTables` as a plain `Record + prefix list`
    // shape with no special cases.
    const headingExact: Record<string, (ctx: SlashCommandContext) => Promise<void>> = {}
    for (let level = 1; level <= 6; level++) {
      headingExact[`h${level}`] = (ctx) => handleHeading(ctx, level)
    }

    return {
      exact: {
        ...headingExact,
        link: (ctx) => {
          ctx.rovingEditor.editor?.chain().focus().insertContent('[[').run()
        },
        'block-ref': (ctx) => {
          // #213 PR 4 — insert the `((` trigger to open the BlockRefPicker
          // (mirrors the `link` handler's `[[`).
          ctx.rovingEditor.editor?.chain().focus().insertContent('((').run()
        },
        tag: (ctx) => {
          ctx.rovingEditor.editor?.chain().focus().insertContent('@').run()
        },
        code: (ctx) => {
          const editor = ctx.rovingEditor.editor
          if (editor) toggleCodeBlockSafely(editor)
        },
        quote: (ctx) => {
          ctx.rovingEditor.editor?.chain().focus().toggleBlockquote().run()
        },
        // #215 — open the visual builder pre-populated instead of dumping raw
        // `{{query …}}` syntax; the builder inserts the generated expression.
        query: (ctx) => ctx.openQueryBuilder(),
        callout: (ctx) => handleCallout(ctx, 'info'),
        'numbered-list': (ctx) => handleNumberedList(ctx),
        divider: (ctx) => handleDivider(ctx),
        table: (ctx) => handleTable(ctx, 'table'),
        // #215 — header-row opt-out.
        'table-no-header': (ctx) => handleTable(ctx, 'table-no-header', false),
      },
      prefix: [
        // Order matters: dynamic-dimension `table:NxM` is matched before
        // the generic `callout-` prefix.
        ['table:', (ctx, item) => handleTable(ctx, item.id)],
        ['callout-', (ctx, item) => handleCallout(ctx, item.id.replace('callout-', ''))],
      ],
    }
  }, [])
}
