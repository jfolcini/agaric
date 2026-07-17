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

import { i18n } from '@/lib/i18n'
import {
  buildInlinePropertySetParams,
  type InlinePropertyLine,
  stripPropertyLines,
} from '@/lib/inline-property-parse'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { OpRef } from '@/lib/tauri'
import { getPropertyDef, setProperty } from '@/lib/tauri'
import { useUndoStore } from '@/stores/undo'

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
  for (const prop of inlineProps) {
    try {
      const def = await getPropertyDef(prop.key)
      const params = buildInlinePropertySetParams(blockId, prop.key, prop.value, def)
      if (params === null) {
        anyFailed = true
        continue
      }
      const resp = await setProperty(params)
      if (resp?.op_refs) opRefs.push(...resp.op_refs)
      strippedLines.add(prop.lineIndex)
    } catch (err: unknown) {
      anyFailed = true
      logger.error(
        'BlockTree',
        'Failed to set inline property from :: syntax',
        { blockId, key: prop.key },
        err,
      )
    }
  }
  if (anyFailed) notify.error(i18n.t('blockTree.setPropertyFailed'))
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
