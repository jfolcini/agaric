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

import {
  applyContentEdit,
  readCurrentContent,
} from '@/components/block-tree/use-block-slash-commands/helpers'
import type {
  SlashCommandContext,
  SlashHandlerTables,
} from '@/components/block-tree/use-block-slash-commands/types'
import type { PickerItem } from '@/editor/SuggestionList'
import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import { serializeBlockSubtree } from '@/lib/block-clipboard'
import { convertBlockContent, turnIdToBlockType } from '@/lib/block-type-convert'
import { EMBED_TOKEN_PREFIX } from '@/lib/embed-token'
import { listStyleForBlockType, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

async function handleHeading(ctx: SlashCommandContext, level: number): Promise<void> {
  const stripped = readCurrentContent(ctx).replace(/^#{1,6}\s/, '')
  const newContent = `${'#'.repeat(level)} ${stripped}`
  await applyContentEdit(ctx, newContent, 'blockTree.setHeadingFailed')
}

async function handleCallout(ctx: SlashCommandContext, calloutType: string): Promise<void> {
  const newContent = `> [!${calloutType.toUpperCase()}] ${readCurrentContent(ctx)}`
  await applyContentEdit(ctx, newContent, 'slash.calloutFailed')
}

/**
 * #4552 slice 2 — `/numbered-list` and `/bullet-list` set the `listStyle`
 * block property instead of prepending a `1. ` / `- ` markdown marker: the
 * marker is now drawn from that property (`ListMarker.tsx` /
 * `list-marker-decoration.ts`), not from `blocks.content`.
 *
 * #4577 — but a property write is not a content edit, and that is what broke:
 * every OTHER structural command goes through `applyContentEdit`, which
 * serializes the live editor and commits it, so the text the user had just
 * typed was persisted as a side effect. These two commit nothing, so typed
 * text still sitting in the editor's commit debounce
 * (`useDebouncedContentCommit`, `CONTENT_COMMIT_DEBOUNCE_MS`) survived only
 * until the next Escape — which discards the pending edit — leaving a block
 * styled as a list with the pre-command content. Flush the pending commit
 * first, through the same `flushActiveDraft` bridge export uses (#2969): it
 * is the editor's own commit path (`debounced.cancel()` + `commitNow()`), not
 * a second mechanism, and it is a no-op when nothing is pending. It is also
 * a no-op for a block carrying an inline `key:: value` line (`commitNow`'s
 * #2675 carve-out), so Escape after a slash command still discards typed
 * text there.
 *
 * This is the one place that argument is written out. Every property-writing
 * slash command has the same shape and carries the same line against this
 * docblock: `useSlashCommandProperty`'s nine handlers, and the two tests that
 * pin the pair.
 */
async function handleListStyle(
  ctx: SlashCommandContext,
  style: 'ordered' | 'bullet',
  failKey: string,
): Promise<void> {
  try {
    await flushActiveDraft()
    await setListStyle(ctx.blockId, style)
  } catch (err) {
    logger.error('useSlashCommandStructural', `setListStyle(${style}) failed`, undefined, err)
    notify.error(ctx.t(failKey))
  }
}

/**
 * #264 — `/turn <type>` converts the current block to the target block type,
 * reusing the shared `convertBlockContent` so the conversion logic is not
 * duplicated across the slash menu and the context-menu "Turn into" group.
 *
 * #4552 slice 2 — additionally writes the `listStyle` property implied by
 * `type` (`listStyleForBlockType`): `'ordered'`/`'bullet'` for the two list
 * targets, `'none'` (cleared) for every other target, so converting a styled
 * block AWAY from a list does not leave it flagged as one.
 */
async function handleTurnInto(ctx: SlashCommandContext, item: PickerItem): Promise<void> {
  const type = turnIdToBlockType(item.id)
  if (!type) return
  const newContent = convertBlockContent(readCurrentContent(ctx), type)
  await applyContentEdit(ctx, newContent, 'slash.turnIntoFailed')
  try {
    await setListStyle(ctx.blockId, listStyleForBlockType(type))
  } catch (err) {
    logger.error('useSlashCommandStructural', 'setListStyle (turn-into) failed', undefined, err)
    notify.error(ctx.t('slash.turnIntoFailed'))
  }
}

async function handleDivider(ctx: SlashCommandContext): Promise<void> {
  await applyContentEdit(ctx, '---', 'slash.dividerFailed')
}

/**
 * #976 (item 13) — `/duplicate` clones the current block + its subtree and
 * inserts the copy right after the original at the same depth. Reuses the exact
 * `serializeBlockSubtree` → `pasteBlocks` path the context-menu "Duplicate" row
 * (`BlockTree.handleDuplicate`) and the `duplicateBlock` keyboard binding fire —
 * no separate clone op.
 *
 * #4577 — the clone is serialized from the STORE, so it needs the same
 * `flushActiveDraft()` the property-writing handlers take (see
 * {@link handleListStyle}): without it, duplicating inside the commit debounce
 * copies the block's pre-typing content.
 */
async function handleDuplicate(ctx: SlashCommandContext): Promise<void> {
  await flushActiveDraft()
  const state = ctx.pageStore.getState()
  if (!state.blocksById.has(ctx.blockId)) return
  const markdown = serializeBlockSubtree(state.blocks, [ctx.blockId])
  if (markdown.length === 0) return
  try {
    await state.pasteBlocks(ctx.blockId, markdown)
  } catch (err) {
    logger.error('useSlashCommandStructural', 'Failed to duplicate block', {
      blockId: ctx.blockId,
      error: err,
    })
    notify.error(ctx.t('blockTree.duplicateFailed'))
  }
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
        // #4550 — insert the `{{embed ` trigger to open the embed-target
        // picker, exactly the way `link` inserts `[[` and `block-ref` inserts
        // `((`. Selection there writes the finished `{{embed ((ULID))}}`
        // token; `StaticBlock` sniffs it on the next static render.
        embed: (ctx) => {
          ctx.rovingEditor.editor?.chain().focus().insertContent(EMBED_TOKEN_PREFIX).run()
        },
        // #286 — open the browse-grid emoji picker; on select it inserts the
        // chosen native emoji at the caret (same active-editor insertContent
        // path the command palette uses for `[[Page]]` links).
        emoji: (ctx) => ctx.openEmojiPicker(),
        callout: (ctx) => handleCallout(ctx, 'info'),
        // #264 — the bare `/turn` parent is a label that surfaces the
        // `turn-*` conversion options inline in the menu; selecting it
        // directly is a no-op (the user picks a concrete target type).
        turn: () => {},
        'numbered-list': (ctx) => handleListStyle(ctx, 'ordered', 'slash.numberedListFailed'),
        'bullet-list': (ctx) => handleListStyle(ctx, 'bullet', 'slash.bulletListFailed'),
        // #976 (item 13) — duplicate the current block + its subtree.
        duplicate: (ctx) => handleDuplicate(ctx),
        divider: (ctx) => handleDivider(ctx),
        table: (ctx) => handleTable(ctx, 'table'),
        // #215 — header-row opt-out.
        'table-no-header': (ctx) => handleTable(ctx, 'table-no-header', false),
      },
      prefix: [
        // Order matters: dynamic-dimension `table:NxM` is matched before
        // the generic `callout-` prefix.
        ['table:', (ctx, item) => handleTable(ctx, item.id)],
        // #264 — `turn-*` block-type conversions. Disjoint from the other
        // prefixes; grouped here with the structural commands.
        ['turn-', (ctx, item) => handleTurnInto(ctx, item)],
        ['callout-', (ctx, item) => handleCallout(ctx, item.id.replace('callout-', ''))],
      ],
    }
  }, [])
}
