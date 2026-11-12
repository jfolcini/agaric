/**
 * The async "commit `key:: value` lines, then strip" save flow shared by every
 * unmount-save path (#2675): `useBlockFlush`, `useEditorBlur` and
 * EditableBlock's `persistUnmount`. The `::` flow must behave the same on all
 * of them, so each calls this instead of a raw `edit()` when the content
 * carries property lines. The checkbox fold and typed tags live here too.
 *
 * `flushSeqByBlock` is a per-block sequence token (#1591): every save bumps it,
 * and an async run re-reads it after its awaits and bails before `edit()` if a
 * newer save took over, so a late save never clobbers a newer one. Module-level
 * because the save paths live in different components; ULID keys cannot
 * collide across pages.
 *
 * The commit functions resolve `false` only when the final `edit()` failed,
 * so the caller keeps the block's draft row. A failed property write leaves its
 * line literal in the saved text and resolves `true`; so does a superseded run,
 * whose newer save owns the content and the draft.
 */

import { unwrap } from '@/lib/app-error'
import type { OpRef, PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import {
  buildInlinePropertySetParams,
  foldPropertyKey,
  type InlinePropertyLine,
  stripPropertyLines,
} from '@/lib/inline-property-parse'
import { clearListStyles } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notifyTagAdded } from '@/lib/name-change-bus'
import { dashedTagName, type TagToken } from '@/lib/name-tokens'
import { notify } from '@/lib/notify'
import { listAllPropertyDefs } from '@/lib/property-save-utils'
import { invalidRepeatRuleMessage, reloadIfRepeating } from '@/lib/repeat-utils'
import { requireActiveScope } from '@/lib/space-scope'
import type { TodoState } from '@/lib/task-states'
import type { FlatBlock } from '@/lib/tree-utils'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

/**
 * The slice of a page block store `commitCheckboxState` touches: the
 * optimistic `blocks` write, `blocksById`, and `load()` for a repeating task's
 * next occurrence. The real store satisfies it as-is.
 */
export interface PageBlockStoreLike {
  setState: (updater: (state: { blocks: FlatBlock[] }) => { blocks: FlatBlock[] }) => void
  getState: () => {
    load: () => Promise<void>
    blocksById?: ReadonlyMap<string, Pick<FlatBlock, 'todo_state'>>
  }
}

/** Per-block flush sequence tokens; see the module doc. */
const flushSeqByBlock = new Map<string, number>()

/**
 * The key a typed `key:: value` line names, and its definition in `spaceId`
 * (#5160): the definition spelled so, else the one definition the key folds to
 * (`foldPropertyKey`), built-ins included. Two that fold alike are never
 * guessed between, and a key nothing folds to is custom; both stay as typed.
 * `listDefs` is asked only when no definition is spelled so. Mirrors
 * `PropertyLines::canonical_key` in the backend.
 */
async function resolveTypedKey(
  typed: string,
  spaceId: string,
  listDefs: () => Promise<PropertyDefinition[]>,
): Promise<{ key: string; def: PropertyDefinition | null }> {
  const exact = unwrap(await commands.getPropertyDef(spaceId, typed))
  if (exact) return { key: typed, def: exact }
  const folded = foldPropertyKey(typed)
  const matches = (await listDefs()).filter((def) => foldPropertyKey(def.key) === folded)
  const [def] = matches
  if (matches.length !== 1 || def === undefined) return { key: typed, def: null }
  return { key: def.key, def }
}

/**
 * Bump and return the block's flush token. Call synchronously at the start of
 * every save of its content; async flows keep the value for their stale check,
 * sync saves bump only to invalidate runs in flight.
 */
export function bumpFlushSeq(blockId: string): number {
  const next = (flushSeqByBlock.get(blockId) ?? 0) + 1
  flushSeqByBlock.set(blockId, next)
  return next
}

/** The block's current flush token, for the stale-run check. */
export function readFlushSeq(blockId: string): number | undefined {
  return flushSeqByBlock.get(blockId)
}

/**
 * Write the parsed property lines through the typed property API, then save
 * `content` with only the succeeded lines stripped. A line whose value does not
 * fit its definition, or whose write fails, stays literal so nothing typed is
 * lost, and all such lines share one toast. A run superseded during its IPCs
 * (`mySeq`) skips `edit()`; the written properties stand. The `set_property`
 * refs seed the undo stack under `rootParentId` (`null` skips that).
 */
export async function commitInlineProperties(opts: {
  blockId: string
  content: string
  inlineProps: InlinePropertyLine[]
  mySeq: number
  edit: (blockId: string, content: string) => Promise<boolean> | void
  rootParentId: string | null
}): Promise<boolean> {
  const { blockId, content, inlineProps, mySeq, edit, rootParentId } = opts
  const strippedLines = new Set<number>()
  const opRefs: OpRef[] = []
  const keptAsText: string[] = []
  // The backend's reason for a malformed `repeat::` rule, preferred over the
  // generic toast because it says what to fix in the line left on screen (#3647).
  let repeatReason: string | null = null
  // The block is on a page of the active space, whose definitions apply.
  const spaceId = useSpaceStore.getState().currentSpaceId
  let defs: Promise<PropertyDefinition[]> | undefined
  const resolveKey = async (typed: string) =>
    spaceId === null
      ? { key: typed, def: null }
      : resolveTypedKey(typed, spaceId, () => (defs ??= listAllPropertyDefs(spaceId)))
  for (const prop of inlineProps) {
    try {
      const { key, def } = await resolveKey(prop.key)
      const params = buildInlinePropertySetParams(blockId, key, prop.value, def)
      if (params === null) {
        keptAsText.push(`${prop.key}:: ${prop.value}`)
        continue
      }
      const resp = unwrap(
        await commands.setProperty(params.blockId, params.key, {
          value_text: params.valueText ?? null,
          value_num: params.valueNum ?? null,
          value_date: params.valueDate ?? null,
          value_ref: null,
          value_bool: params.valueBool ?? null,
        }),
      )
      if (resp?.op_refs) opRefs.push(...resp.op_refs)
      strippedLines.add(prop.lineIndex)
    } catch (err: unknown) {
      keptAsText.push(`${prop.key}:: ${prop.value}`)
      repeatReason ??= invalidRepeatRuleMessage(err)
      logger.error(
        'BlockTree',
        'Failed to set inline property from :: syntax',
        { blockId, key: prop.key },
        err,
      )
    }
  }
  if (keptAsText.length > 0) {
    notify.error(
      repeatReason ?? i18n.t('blockTree.propertyKeptAsText', { lines: keptAsText.join(', ') }),
    )
  }
  // Superseded: skip `edit()` and resolve `true`. Re-seeding a draft with this
  // stale content would resurrect the stripped line over the newer text.
  if (readFlushSeq(blockId) !== mySeq) return true
  const outcome = edit(blockId, stripPropertyLines(content, strippedLines))
  // So Ctrl+Z can revert the property write; `onNewAction` ignores empty refs.
  if (strippedLines.size > 0 && rootParentId) {
    useUndoStore.getState().onNewAction(rootParentId, opRefs)
  }
  const ok = await Promise.resolve(outcome).catch((err: unknown) => {
    // Store actions resolve `false`; an escaped rejection counts as a failed save.
    logger.warn('BlockTree', 'content edit rejected after inline property commit', { blockId }, err)
    return false as const
  })
  return ok !== false
}

/**
 * Fold a leading checkbox marker (`- [ ] `, `- [x] `, `- [/] `, `- [-] `) into
 * `set_todo_state`, then save the marker-stripped content, so every
 * unmount-save path folds it alike (#3278).
 *
 * The state write is awaited first: a rejected one must neither lose the task
 * (marker stripped, state never set) nor show a box the backend never recorded.
 * On success it adopts the echo, writes it into `pageStore`, strips the marker
 * and records one undo entry; a block not already a task loses its list style
 * first, as a task is a list kind exclusive with bulleted and numbered (#5691),
 * and both writes share the entry (#6156). DONE on a repeating task reloads
 * the page. On failure the raw content, marker intact, is saved so the box
 * stays re-parseable. Superseded runs and the `false` result behave as in
 * `commitInlineProperties`.
 */
export async function commitCheckboxState(opts: {
  blockId: string
  /** Raw unmounted content, marker intact — persisted verbatim on failure. */
  content: string
  /** Marker-stripped content — persisted on success. */
  cleanContent: string
  todoState: TodoState
  mySeq: number
  edit: (blockId: string, content: string) => Promise<boolean> | void
  pageStore?: PageBlockStoreLike | undefined
  rootParentId: string | null
}): Promise<boolean> {
  const { blockId, content, cleanContent, todoState, mySeq, edit, pageStore, rootParentId } = opts
  const wasTask = (pageStore?.getState().blocksById?.get(blockId)?.todo_state ?? null) !== null
  try {
    const echo = unwrap(await commands.setTodoState(blockId, todoState))
    const cleared = wasTask ? [] : await clearListStyles([blockId])
    if (readFlushSeq(blockId) !== mySeq) return true
    const settledState = typeof echo.todo_state === 'string' ? echo.todo_state : todoState
    pageStore?.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: settledState } : b)),
    }))
    const outcome = edit(blockId, cleanContent)
    // The edit's undo entry joins this one: state and style revert together (#6156).
    if (rootParentId) {
      useUndoStore.getState().onNewAction(rootParentId, [...echo.op_refs, ...cleared])
    }
    const ok = await Promise.resolve(outcome).catch((err: unknown) => {
      logger.warn(
        'BlockTree',
        'content edit rejected after checkbox state commit',
        { blockId },
        err,
      )
      return false as const
    })
    if (todoState === 'DONE' && pageStore) await reloadIfRepeating(blockId, pageStore)
    return ok !== false
  } catch (err: unknown) {
    if (readFlushSeq(blockId) !== mySeq) {
      // Superseded: do not clobber the newer save, but still report the error.
      logger.error(
        'BlockTree',
        'Failed to set task state from checkbox syntax (superseded)',
        { blockId },
        err,
      )
      notify.error(i18n.t('blockTree.setTaskStateFailed'))
      return true
    }
    // Keep the marker so the task state stays recoverable; no optimistic
    // state was written, so nothing to roll back.
    logger.error('BlockTree', 'Failed to set task state from checkbox syntax', { blockId }, err)
    notify.error(i18n.t('blockTree.setTaskStateFailed'))
    const outcome = edit(blockId, content)
    const ok = await Promise.resolve(outcome).catch((editErr: unknown) => {
      logger.warn(
        'BlockTree',
        'content edit rejected after failed checkbox state commit',
        { blockId },
        editErr,
      )
      return false as const
    })
    return ok !== false
  }
}

/** Whether a store write settled as a success; store actions resolve `false` on failure. */
async function saved(outcome: Promise<boolean> | void, blockId: string): Promise<boolean> {
  try {
    return (await outcome) !== false
  } catch (err) {
    logger.warn('unmount-flush', 'content edit rejected', { blockId }, err)
    return false
  }
}

/**
 * The id of each of `names` in `spaceId`, keyed lowercased: the existing tag of
 * that name in any case, else the create's answer for its dashed name (#6278).
 * A name whose lookup or create fails is missing. Stops creating once
 * `current` says a newer save took over.
 */
async function tagIds(
  names: string[],
  spaceId: string,
  current: () => boolean,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  try {
    for (const tag of unwrap(await commands.listAllTagsInSpace(requireActiveScope(spaceId)))) {
      const key = tag.name.toLowerCase()
      if (!ids.has(key)) ids.set(key, tag.tag_id)
    }
  } catch (err) {
    logger.warn('unmount-flush', 'tag lookup failed, the tags stay text', { spaceId }, err)
    return ids
  }
  for (const typed of names) {
    const key = typed.toLowerCase()
    if (ids.has(key)) continue
    if (!current()) break
    const name = dashedTagName(typed)
    try {
      const scope = requireActiveScope(spaceId)
      const row = unwrap(await commands.createBlock('tag', name, null, null, scope, null))
      ids.set(key, row.id)
      useResolveStore.getState().set(row.id, name, false)
      notifyTagAdded(row.id, name, spaceId)
    } catch (err) {
      logger.warn('unmount-flush', 'tag create failed, the tag stays text', { name }, err)
    }
  }
  return ids
}

/**
 * Once `content` is saved as text, write its `tags` as the tags they name.
 * Saving first keeps the text durable while the lookup runs. Resolves `false`
 * only when that save failed.
 */
export async function commitTypedTags(opts: {
  blockId: string
  content: string
  tags: TagToken[]
  textSaved: Promise<boolean> | void
  mySeq: number
  edit: (blockId: string, content: string) => Promise<boolean> | void
}): Promise<boolean> {
  const { blockId, content, tags, textSaved, mySeq, edit } = opts
  if (!(await saved(textSaved, blockId))) return false
  const spaceId = useSpaceStore.getState().currentSpaceId
  if (spaceId === null) return true
  const current = () => readFlushSeq(blockId) === mySeq
  const ids = await tagIds(
    tags.map((tag) => tag.name),
    spaceId,
    current,
  )
  let named = content
  for (const tag of tags.toReversed()) {
    const id = ids.get(tag.name.toLowerCase())
    if (id !== undefined) named = `${named.slice(0, tag.start)}#[${id}]${named.slice(tag.end)}`
  }
  if (named !== content && current()) await saved(edit(blockId, named), blockId)
  return true
}
