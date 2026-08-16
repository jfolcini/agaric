/**
 * inline-property-commit — the async "commit `key:: value` lines, then strip"
 * save flow shared by EVERY unmount-save path (#2675).
 *
 * A block's serialized content is committed from three distinct places:
 *
 *   1. `useBlockFlush` (BlockTree's imperative flush — keyboard boundary
 *      navigation, DnD, zoom change, collapse, container pointer-down),
 *   2. `useEditorBlur` Step 5 (DOM blur — clicking another block, the
 *      sidebar, anywhere outside the editor: the DOMINANT save path),
 *   3. `persistUnmount` in EditableBlock (programmatic focus moves — the
 *      auto-mount effect and `handleFocus`, e.g. Enter-to-create).
 *
 * The documented `::` flow ("pick a key, type the value, it commits when the
 * block is saved") must behave identically on all three, so the parse →
 * `set_property` → strip-only-on-success routine lives here and each path
 * calls it instead of a raw `edit()` when the content carries property lines.
 *
 * ## Supersession (the flush sequence token)
 *
 * `flushSeqByBlock` is the per-block sequence token previously private to
 * `useBlockFlush` (#1591): every save that goes async bumps the block's token
 * before awaiting IPCs and re-reads it afterwards — if a newer save on the
 * SAME block bumped it in the meantime, the stale run bails before calling
 * `edit()`, so a late-resolving save can never clobber a newer one. It is
 * module-level (not a hook ref) because the three save paths above live in
 * different components; block ids are ULIDs, so a global map cannot collide
 * across pages, and it also guards the same block edited from two mounted
 * trees. Sync saves (plain edit / split) bump the token too, via
 * `bumpFlushSeq`, so they invalidate any in-flight async run.
 *
 * ## Draft-row gating
 *
 * `commitInlineProperties` resolves `false` ONLY when the final content
 * `edit()` failed (the typed text is not durably committed — callers must
 * keep/re-seed the block's draft row, mirroring their plain-edit handling).
 * Property-write failures alone resolve `true`: the failed lines stay
 * LITERAL in the committed content, so the text is durable. A superseded run
 * also resolves `true` — the newer save session owns the block's content and
 * draft lifecycle.
 */

import { unwrap } from '@/lib/app-error'
import type { OpRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import {
  buildInlinePropertySetParams,
  type InlinePropertyLine,
  stripPropertyLines,
} from '@/lib/inline-property-parse'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { invalidRepeatRuleMessage } from '@/lib/repeat-utils'
import type { TodoState } from '@/lib/task-states'
import type { FlatBlock } from '@/lib/tree-utils'
import { useUndoStore } from '@/stores/undo'

/**
 * The minimal structural surface `commitCheckboxState`'s optimistic write
 * needs from a page block store: a Zustand-style `setState` over an object
 * carrying `blocks`. Declared here (instead of importing the concrete
 * `StoreApi<PageBlockState>` from `@/stores/page-blocks`) so this `lib/`
 * module never imports the `stores/` tier (#3121's lower-tier-never-imports-
 * higher rule) — the real page-block store's `setState` structurally
 * satisfies this as-is, so every caller passes it unchanged.
 */
export interface PageBlockStoreLike {
  setState: (updater: (state: { blocks: FlatBlock[] }) => { blocks: FlatBlock[] }) => void
}

/** Per-block flush sequence tokens — see the module docstring. */
const flushSeqByBlock = new Map<string, number>()

/**
 * Bump and return the block's flush sequence token. Call synchronously at the
 * start of EVERY save of the block's content (async property/checkbox flows
 * capture the returned value for their post-await stale check; sync plain
 * edits / splits bump without capturing, purely to invalidate in-flight
 * async runs).
 */
export function bumpFlushSeq(blockId: string): number {
  const next = (flushSeqByBlock.get(blockId) ?? 0) + 1
  flushSeqByBlock.set(blockId, next)
  return next
}

/** Read the block's current flush sequence token (stale-run check). */
export function readFlushSeq(blockId: string): number | undefined {
  return flushSeqByBlock.get(blockId)
}

/**
 * Commit the parsed inline property lines via the typed property API, then
 * persist `content` with ONLY the succeeded lines stripped. See
 * `use-block-flush.ts` step 5 and `inline-property-parse.ts` for the rules.
 *
 * - Each line: `getPropertyDef` → `buildInlinePropertySetParams` (honours the
 *   definition type; `null` params = value not representable → treated as a
 *   rejected write) → `setProperty` (upsert; the backend enforces select
 *   membership etc.).
 * - A line is stripped ONLY after its write succeeds; failures leave it
 *   literal so nothing typed is ever lost, and produce ONE toast total.
 * - `mySeq` is the token captured from `bumpFlushSeq(blockId)` at save start;
 *   if a newer save bumped it while our IPCs were in flight, we bail without
 *   calling `edit()` (properties already written stand — idempotent upserts
 *   a newer flush would re-issue anyway).
 * - On success the `set_property` op refs seed the ref-addressed undo stack
 *   (the content strip gets its own entry from `edit()`'s own undo
 *   notification), keyed on `rootParentId`; pass `null` to skip the seed.
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
  let anyFailed = false
  // #3647 — the backend's reason for rejecting a `repeat:: …` line, if one
  // carried a malformed rule. Preferred over the generic toast: it names which
  // rule is wrong and why, right where the user typed it. The rejected line
  // stays LITERAL in the committed content (see `strippedLines`), so the text
  // they now know how to fix is still on screen.
  let repeatReason: string | null = null
  for (const prop of inlineProps) {
    try {
      const def = unwrap(await commands.getPropertyDef(prop.key))
      const params = buildInlinePropertySetParams(blockId, prop.key, prop.value, def)
      if (params === null) {
        anyFailed = true
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
      anyFailed = true
      repeatReason ??= invalidRepeatRuleMessage(err)
      logger.error(
        'BlockTree',
        'Failed to set inline property from :: syntax',
        { blockId, key: prop.key },
        err,
      )
    }
  }
  if (anyFailed) notify.error(repeatReason ?? i18n.t('blockTree.setPropertyFailed'))
  // A newer save on this block superseded us while the IPCs were in flight —
  // bail without calling `edit()` so we don't clobber it. The newer session
  // owns the block's content + draft lifecycle, so resolve `true` (callers
  // must not re-seed a draft row with OUR stale content — that would
  // resurrect the stripped line at next boot over the newer content).
  if (readFlushSeq(blockId) !== mySeq) return true
  const outcome = edit(blockId, stripPropertyLines(content, strippedLines))
  // Seed the undo stack with the set_property op refs so Ctrl+Z can revert
  // the property write itself; `onNewAction` ignores an empty refs array.
  if (strippedLines.size > 0 && rootParentId) {
    useUndoStore.getState().onNewAction(rootParentId, opRefs)
  }
  const ok = await Promise.resolve(outcome).catch((err: unknown) => {
    // Store actions resolve false rather than reject; treat an escaped
    // rejection as a failed save (the safe direction for draft gating).
    logger.warn('BlockTree', 'content edit rejected after inline property commit', { blockId }, err)
    return false as const
  })
  return ok !== false
}

/**
 * Commit a folded leading checkbox marker (`- [ ] ` / `- [x] ` / `- [/] ` /
 * `- [-] `) via the typed `set_todo_state` command, then persist the
 * marker-stripped content — mirroring `commitInlineProperties`'s "commit,
 * then strip on success" shape (#1074) so all three unmount-save paths
 * (`useBlockFlush`, `useEditorBlur` Step 5, `persistUnmount`) agree on
 * checkbox folding instead of only one of them doing it (#3278).
 *
 * - AWAITS `set_todo_state` before stripping the marker or writing the
 *   optimistic `todo_state`: a rejected state write must not silently lose
 *   the task state (marker stripped, state never committed) nor leave a
 *   phantom checked box the backend never recorded.
 * - On SUCCESS: adopts the backend echo for `todo_state` (falls back to the
 *   sent state), optimistically writes it into `pageStore`, strips the
 *   marker via `edit(cleanContent)`, and nudges the undo stack.
 * - On FAILURE (state write rejected): persists the RAW content (marker
 *   intact) via `edit(content)` so the box stays re-parseable, and writes no
 *   optimistic state.
 * - `mySeq` / `readFlushSeq` guard against a newer flush on the same block
 *   clobbering this stale run — see the module docstring. A superseded run
 *   (success or failure) bails without calling `edit()` and resolves `true`
 *   (the newer session owns the block's content + draft lifecycle), mirroring
 *   `commitInlineProperties`'s supersede handling.
 * - `pageStore` is optional: callers/tests that never produce checkbox-marker
 *   content may omit it; when present, only its `blocks` array is touched.
 *
 * Resolves `false` ONLY when the final content `edit()` failed (mirroring
 * `commitInlineProperties`'s draft-gating contract).
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
  try {
    const echo = unwrap(await commands.setTodoState(blockId, todoState))
    // A newer flush on this block superseded us while the IPC was in
    // flight — bail without applying so we don't clobber it.
    if (readFlushSeq(blockId) !== mySeq) return true
    const settledState = typeof echo?.todo_state === 'string' ? echo.todo_state : todoState
    pageStore?.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, todo_state: settledState } : b)),
    }))
    // Strip the marker only now that the state is committed.
    const outcome = edit(blockId, cleanContent)
    if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
    const ok = await Promise.resolve(outcome).catch((err: unknown) => {
      logger.warn(
        'BlockTree',
        'content edit rejected after checkbox state commit',
        { blockId },
        err,
      )
      return false as const
    })
    return ok !== false
  } catch (err: unknown) {
    if (readFlushSeq(blockId) !== mySeq) {
      // A newer flush on this block superseded us — don't clobber it with
      // this stale run's raw content, but still surface the error.
      logger.error(
        'BlockTree',
        'Failed to set task state from checkbox syntax (superseded)',
        { blockId },
        err,
      )
      notify.error(i18n.t('blockTree.setTaskStateFailed'))
      return true
    }
    // State write failed — do NOT strip the marker. Persist the raw content
    // (with the `- [ ] `/`- [x] ` marker intact) so the task state stays
    // recoverable, and write no optimistic `todo_state` (nothing to roll
    // back since we deferred it past the await).
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
