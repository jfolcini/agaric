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

function handleTable(ctx: SlashCommandContext, id: string): void {
  let rows = 3
  let cols = 3
  const dimMatch = id.match(/^table:(\d+):(\d+)$/)
  if (dimMatch) {
    rows = Number.parseInt(dimMatch[1] as string, 10)
    cols = Number.parseInt(dimMatch[2] as string, 10)
  }
  ctx.rovingEditor.editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
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
        query: (ctx) => {
          ctx.rovingEditor.editor?.chain().focus().insertContent('{{query type:tag expr:}}').run()
        },
        callout: (ctx) => handleCallout(ctx, 'info'),
        'numbered-list': (ctx) => handleNumberedList(ctx),
        divider: (ctx) => handleDivider(ctx),
        table: (ctx) => handleTable(ctx, 'table'),
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
