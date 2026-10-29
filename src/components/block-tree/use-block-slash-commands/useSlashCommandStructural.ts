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

import type { Editor } from '@tiptap/react'
import { useMemo } from 'react'

import {
  applyContentEdit,
  notifyUndo,
  readCurrentContent,
} from '@/components/block-tree/use-block-slash-commands/helpers'
import type {
  SlashCommandContext,
  SlashHandlerTables,
} from '@/components/block-tree/use-block-slash-commands/types'
import type { PickerItem } from '@/editor/SuggestionList'
import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'
import { flushActiveDraft } from '@/lib/active-draft-flush'
import {
  type BlockTypeToken,
  convertBlockContent,
  detectBlockType,
  turnIdToBlockType,
} from '@/lib/block-type-convert'
import { EMBED_TOKEN_PREFIX } from '@/lib/embed-token'
import { listStyleForBlockType, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { clearTaskStates } from '@/stores/page-blocks'

/**
 * A heading, a code block, a quote or a callout is not a list: these commands
 * clear the block's list style, as every Turn into target but the two lists
 * does (#5691). The editor's pending commit is flushed first, as
 * {@link handleListStyle} explains, so the style never goes without the change
 * `/code` and `/quote` make in the editor. Page mode clears it its own way.
 * A command whose `edit_block` was refused leaves the style alone: the block
 * is unchanged, and that refusal has already been toasted. The clear joins the
 * command's undo entry, which its edit recorded just before (#6156).
 */
async function clearListStyleFor(ctx: SlashCommandContext, failKey: string): Promise<void> {
  if (ctx.clearListStyle) {
    ctx.clearListStyle()
    return
  }
  try {
    await flushActiveDraft()
    notifyUndo(ctx.rootParentId, await setListStyle(ctx.blockId, 'none'))
  } catch (err) {
    logger.error('useSlashCommandStructural', 'clearing the list style failed', undefined, err)
    notify.error(ctx.t(failKey))
  }
}

async function handleHeading(ctx: SlashCommandContext, level: number): Promise<void> {
  const stripped = readCurrentContent(ctx).replace(/^#{1,6}\s/, '')
  const newContent = `${'#'.repeat(level)} ${stripped}`
  if (!(await applyContentEdit(ctx, newContent, 'blockTree.setHeadingFailed'))) return
  await clearListStyleFor(ctx, 'blockTree.clearListStyleFailed')
}

async function handleCallout(ctx: SlashCommandContext, calloutType: string): Promise<void> {
  const newContent = `> [!${calloutType.toUpperCase()}] ${readCurrentContent(ctx)}`
  if (!(await applyContentEdit(ctx, newContent, 'slash.calloutFailed'))) return
  await clearListStyleFor(ctx, 'slash.calloutFailed')
}

async function handleToggleBlock(
  ctx: SlashCommandContext,
  toggle: (editor: Editor) => void,
): Promise<void> {
  const editor = ctx.rovingEditor.editor
  if (!editor) return
  toggle(editor)
  await clearListStyleFor(ctx, 'blockTree.clearListStyleFailed')
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
 * (`useDebouncedContentCommit`, `CONTENT_COMMIT_DEBOUNCE_MS`) was not saved
 * with the style: a Discard straight after dropped it, leaving a block styled
 * as a list with the pre-command content. Flush the pending commit
 * first, through the same `flushActiveDraft` bridge export uses (#2969): it
 * is the editor's own commit path (`debounced.cancel()` + `commitNow()`), not
 * a second mechanism, and it is a no-op when nothing is pending. It is also
 * a no-op for a block carrying an inline `key:: value` line (`commitNow`'s
 * #2675 carve-out), so Discard after a slash command still drops typed
 * text there.
 *
 * This is the one place that argument is written out. Every property-writing
 * slash command has the same shape and carries the same line against this
 * docblock: `useSlashCommandProperty`'s nine handlers, and the two tests that
 * pin the pair.
 *
 * A task is a list kind (#5691 D3): once the style is written, the block
 * loses its task state, in the same undo entry (#6156).
 */
async function handleListStyle(
  ctx: SlashCommandContext,
  style: 'ordered' | 'bullet',
  failKey: string,
): Promise<void> {
  // A heading, quote, callout or code block shows no bullet or number, so a style
  // written on it would be hidden: making it a list is a kind change, which Turn into makes.
  if (detectBlockType(readCurrentContent(ctx)) !== 'paragraph') {
    await turnInto(ctx, style === 'ordered' ? 'numbered-list' : 'bullet-list')
    return
  }
  try {
    await flushActiveDraft()
    notifyUndo(ctx.rootParentId, await setListStyle(ctx.blockId, style))
  } catch (err) {
    logger.error('useSlashCommandStructural', `setListStyle(${style}) failed`, undefined, err)
    notify.error(ctx.t(failKey))
    return
  }
  await clearTaskStates(ctx.pageStore, [ctx.blockId])
}

/**
 * #264 — `/turn <type>` converts the current block to the target block type,
 * reusing the shared `convertBlockContent` so the conversion logic is not
 * duplicated across the slash menu and the context-menu "Turn into" group.
 *
 * #4552 slice 2 — additionally writes the `listStyle` property implied by
 * `type` (`listStyleForBlockType`): `'ordered'`/`'bullet'` for the two list
 * targets, `'none'` (cleared) for every other target, so converting a styled
 * block AWAY from a list does not leave it flagged as one. A block turned
 * into a list loses its task state (#5691 D3), once the style is written. Both
 * join the edit's undo entry (#6156).
 */
async function handleTurnInto(ctx: SlashCommandContext, item: PickerItem): Promise<void> {
  const type = turnIdToBlockType(item.id)
  if (type) await turnInto(ctx, type)
}

async function turnInto(ctx: SlashCommandContext, type: BlockTypeToken): Promise<void> {
  const newContent = convertBlockContent(readCurrentContent(ctx), type)
  if (!(await applyContentEdit(ctx, newContent, 'slash.turnIntoFailed'))) return
  const style = listStyleForBlockType(type)
  try {
    notifyUndo(ctx.rootParentId, await setListStyle(ctx.blockId, style))
  } catch (err) {
    logger.error('useSlashCommandStructural', 'setListStyle (turn-into) failed', undefined, err)
    notify.error(ctx.t('slash.turnIntoFailed'))
    return
  }
  if (style !== 'none') await clearTaskStates(ctx.pageStore, [ctx.blockId])
}

async function handleDivider(ctx: SlashCommandContext): Promise<void> {
  await applyContentEdit(ctx, '---', 'slash.dividerFailed')
}

/**
 * #976 (item 13) / #5140 — `/duplicate` copies the current block + its subtree
 * right after the original at the same depth, through the same store action the
 * context-menu "Duplicate" row (`BlockTree.handleDuplicate`) and the
 * `duplicateBlock` keyboard binding use.
 *
 * #4577 — the backend copies the STORED rows, so it needs the same
 * `flushActiveDraft()` the property-writing handlers take (see
 * {@link handleListStyle}): without it, duplicating inside the commit debounce
 * copies the block's pre-typing content.
 */
async function handleDuplicate(ctx: SlashCommandContext): Promise<void> {
  await flushActiveDraft()
  await ctx.pageStore.getState().duplicateBlock(ctx.blockId)
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
        code: (ctx) => handleToggleBlock(ctx, (editor) => toggleCodeBlockSafely(editor)),
        quote: (ctx) =>
          handleToggleBlock(ctx, (editor) => editor.chain().focus().toggleBlockquote().run()),
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
        // Opens the size grid at the caret; the grid inserts the table.
        table: (ctx) => ctx.openTablePicker(),
      },
      prefix: [
        // #264 — `turn-*` block-type conversions. Disjoint from the other
        // prefixes; grouped here with the structural commands.
        ['turn-', (ctx, item) => handleTurnInto(ctx, item)],
        ['callout-', (ctx, item) => handleCallout(ctx, item.id.replace('callout-', ''))],
      ],
    }
  }, [])
}
