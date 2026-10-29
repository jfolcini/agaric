/**
 * List-ness as a block attribute (#3000).
 *
 * A block's list style is stored as a generic `block_properties` row under the
 * key {@link LIST_STYLE_KEY} with a `value_text` of `'bullet'` or `'ordered'`.
 * The **absence** of the row means {@link ListStyle} `'none'` — a plain block —
 * so `'none'` is never written; it is represented by clearing the property.
 *
 * This module is the single source of truth for the key string, the value
 * vocabulary, and the read/write helpers, so no consumer spells the raw key or
 * value literals. See `docs/architecture/list-ergonomics.md` for the model.
 */

import { parse } from '@/editor/markdown-serializer'
import { unwrap } from '@/lib/app-error'
import type { OpRef, PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { parseEmbedToken } from '@/lib/embed-token'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

/** The block-property key under which list-ness is stored. */
export const LIST_STYLE_KEY = 'listStyle'

/**
 * A block's list style. `'none'` is the default and is represented by the
 * absence of a {@link LIST_STYLE_KEY} property row (never stored explicitly).
 */
export type ListStyle = 'none' | 'bullet' | 'ordered'

/** The two styles that are actually persisted (`'none'` clears the row). */
export const STORED_LIST_STYLES = ['bullet', 'ordered'] as const

/** `options` JSON for the `select`-type property definition (seed migration). */
export const LIST_STYLE_OPTIONS_JSON = JSON.stringify(STORED_LIST_STYLES)

/** Narrow an arbitrary string to a stored {@link ListStyle}, or `'none'`. */
export function asListStyle(value: string | null | undefined): ListStyle {
  return value === 'bullet' || value === 'ordered' ? value : 'none'
}

/**
 * Project a block's property rows to its {@link ListStyle}. Returns `'none'`
 * when no `listStyle` row is present (or its value is unrecognised).
 */
export function listStyleFromRows(rows: readonly PropertyRow[] | undefined): ListStyle {
  const row = rows?.find((r) => r.key === LIST_STYLE_KEY)
  return asListStyle(row?.value_text)
}

/**
 * Set a block's list style. Writing `'none'` clears the property (delete)
 * rather than storing a sentinel, keeping the "absent = none" invariant.
 * Resolves the refs of the ops it appended, for the caller's undo entry
 * (#6156): a kind change and the style it takes off are one undo step.
 */
export async function setListStyle(blockId: string, style: ListStyle): Promise<OpRef[]> {
  if (style === 'none') return clearListStyle(blockId)
  return unwrap(
    await commands.setProperty(blockId, LIST_STYLE_KEY, {
      value_text: style,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }),
  ).op_refs
}

/** Clear a block's list style (equivalent to `setListStyle(id, 'none')`). */
export async function clearListStyle(blockId: string): Promise<OpRef[]> {
  return unwrap(await commands.deleteProperty(blockId, LIST_STYLE_KEY)).op_refs
}

/**
 * Clear the list style of those of `ids` that store one, as making them tasks
 * does (#5691 D3: a task is a third list kind, exclusive with bulleted and
 * numbered). One read finds them, as no command deletes a property on many
 * blocks. Call it once the task state is written, so a refused write clears
 * nothing. Resolves whether it cleared them all; a failure is logged and told.
 */
export async function clearListStyles(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return true
  try {
    const rows = unwrap(await commands.getBatchProperties([...ids]))
    for (const id of ids) {
      if (listStyleFromRows(rows[id]) !== 'none') await clearListStyle(id)
    }
    return true
  } catch (err) {
    logger.error('list-style', 'Failed to clear the list styles of new tasks', { ids }, err)
    notify.error(i18n.t('blockTree.clearListStyleFailed'))
    return false
  }
}

/**
 * The list style a block shows (#5691 D3): a block holding a task state shows
 * its checkbox and no bullet or number, whatever `listStyle` it stores. It is
 * numbered as a plain block is (`computeListOrdinals`): a task between two
 * numbered blocks ends their run, and the next one starts again at `1.`.
 */
export function shownListStyle(style: ListStyle, isTask: boolean): ListStyle {
  return isTask ? 'none' : style
}

/**
 * The {@link ListStyle} a Turn-into target implies (#4552 slice 2).
 * `'numbered-list'` / `'bullet-list'` imply the matching stored style; every
 * other {@link BlockTypeToken} implies `'none'` — converting a styled block to
 * a heading/quote/paragraph/code/callout clears its `listStyle` (`setListStyle`
 * deletes the property for `'none'` rather than storing a sentinel), so the
 * block does not stay flagged as a list it no longer visually is.
 */
export function listStyleForBlockType(type: BlockTypeToken): ListStyle {
  if (type === 'numbered-list') return 'ordered'
  if (type === 'bullet-list') return 'bullet'
  return 'none'
}

/**
 * Whether a block shows its list style's marker. A marker is only for a bullet
 * or numbered block, in block mode and in page mode alike, and such a block
 * opens with a paragraph that is not a query or an embed. A heading, code
 * block, quote, callout, table, divider or math block shows none, whatever
 * `listStyle` row it carries: an import, *Edit as Markdown*, the property
 * drawer or another device can store one on it. `firstNodeType` is the type of
 * the block's first top-level node.
 */
export function showsListMarker(firstNodeType: string | undefined, queryOrEmbed: boolean): boolean {
  return firstNodeType === 'paragraph' && !queryOrEmbed
}

/** {@link showsListMarker} for a block's stored markdown, read as `StaticBlock` reads it. */
export function contentShowsListMarker(content: string): boolean {
  const query = content.startsWith('{{query ') && content.endsWith('}}')
  return showsListMarker(
    parse(content).content?.[0]?.type,
    query || parseEmbedToken(content) !== null,
  )
}
