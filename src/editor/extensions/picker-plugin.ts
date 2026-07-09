/**
 * Shared `addProseMirrorPlugins()` shell for the 5 picker extensions
 * (AtTagPicker, BlockLinkPicker, BlockRefPicker, SlashCommand,
 * PropertyPicker). Captures the duplicated `Suggestion(...)` boilerplate:
 *   - the items try/catch + logger.warn wrapper
 *   - the createSuggestionRenderer(displayName, pluginKey) wiring
 *   - the editor / pluginKey / char passthrough
 *
 * Per-picker variations (allowSpaces, allowedPrefixes, command body,
 * optional render override for slash-command's auto-execute timer) are
 * passed through cfg without defaulting — preserving each picker's
 * existing behaviour byte-equivalently.
 */

import type { Editor } from '@tiptap/core'
import type { PluginKey, Transaction } from '@tiptap/pm/state'
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion'

import { logger } from '@/lib/logger'

import { createSuggestionRenderer } from '../suggestion-renderer'
import type { PickerItem } from '../SuggestionList'

export interface PickerPluginConfig {
  /** Component name passed to `logger.warn` (e.g. 'BlockLinkPicker'). */
  loggerComponent: string
  /** Display name shown in the suggestion popup header (e.g. 'Block links'). */
  displayName: string
  /** Plugin key used by both Suggestion and the renderer. */
  pluginKey: PluginKey
  /** Trigger character(s) — '@', '[[', '((', '/', '::'. */
  char: string
  /** Whether the suggestion popup allows spaces in queries. Omit to use the TipTap default (false). */
  allowSpaces?: boolean
  /** Explicit allowedPrefixes list. Omit to use the TipTap default ([' ']). */
  allowedPrefixes?: string[] | null
  /**
   * Optional gate deciding whether a match should open the popup at all.
   * Omit to use the TipTap default (always allow). Used by the emoji `:`
   * picker to require `:` + ≥2 word-chars so it stays dormant for a bare
   * `:`, a trailing `: `, and the `::` property trigger.
   */
  allow?: SuggestionOptions<PickerItem>['allow']
  /** Editor reference (passed via this.editor at the call site). */
  editor: Editor
  /** Items callback wrapped by the helper with try/catch + logger.warn. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Picker-specific command body (insertion logic). */
  command: NonNullable<SuggestionOptions<PickerItem>['command']>
  /**
   * Optional render override. When omitted, the helper provides
   * `() => createSuggestionRenderer(displayName, pluginKey)`.
   * SlashCommand passes a custom render that wraps the base renderer
   * with auto-execute timer logic.
   */
  render?: SuggestionOptions<PickerItem>['render']
}

export function createPickerPlugin(cfg: PickerPluginConfig) {
  return Suggestion<PickerItem>({
    editor: cfg.editor,
    pluginKey: cfg.pluginKey,
    char: cfg.char,
    ...(cfg.allowSpaces !== undefined ? { allowSpaces: cfg.allowSpaces } : {}),
    ...(cfg.allowedPrefixes !== undefined ? { allowedPrefixes: cfg.allowedPrefixes } : {}),
    ...(cfg.allow !== undefined ? { allow: cfg.allow } : {}),
    items: async ({ query }) => {
      try {
        return await cfg.items(query)
      } catch (err) {
        logger.warn(cfg.loggerComponent, 'items callback failed, returning empty', { query }, err)
        return []
      }
    },
    command: cfg.command,
    render:
      cfg.render ?? (() => createSuggestionRenderer(cfg.displayName, cfg.pluginKey, cfg.char)),
  })
}

// ── ──────────────────────────────────────────────────────────────
//
// Position tracking across the async window.
//
// The roving editor is a SINGLETON: switching blocks swaps the document
// in-place (`replaceDocSilently` dispatches a full-doc `replaceWith`)
// without destroying the editor, so neither `editor.isDestroyed` nor a
// doc-size check can detect that the captured offset now points into a
// DIFFERENT block's document. Map the offset through every transaction
// instead: a doc swap (or any edit that removes the surrounding text)
// deletes the position on both sides (`deletedAcross`), which is the
// signal to drop the pending insertion rather than splice a token into
// an unrelated document. Same-block edits merely shift the offset, and
// the mapped position keeps the insertion anchored correctly.

interface TrackedInsertPosition {
  /** Mapped offset, or `null` once the position was deleted across. */
  readonly pos: number | null
  /** Detach the transaction listener. Always call when settled. */
  stop: () => void
}

function trackInsertPosition(editor: Editor, initialPos: number): TrackedInsertPosition {
  let pos: number | null = initialPos
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (pos === null) return
    const mapped = transaction.mapping.mapResult(pos)
    pos = mapped.deletedAcross ? null : mapped.pos
  }
  // Unit-test doubles pass minimal `{ chain, state }` editors without the
  // event emitter; skip tracking there (the doc-size staleness check in the
  // callers still applies, preserving the untracked fallback behaviour).
  const canTrack = typeof editor.on === 'function' && typeof editor.off === 'function'
  if (canTrack) editor.on('transaction', onTransaction)
  return {
    get pos() {
      return pos
    },
    stop: () => {
      if (canTrack) editor.off('transaction', onTransaction)
    },
  }
}

// ── ──────────────────────────────────────────────────────────────
//
// Shared async resolve-and-insert path for the 3 token-inserting pickers
// (AtTagPicker `#TAG`, BlockLinkPicker `[[ULID]]`, BlockRefPicker `((ULID))`).
//
// All three implement the same race-condition guard:
//   - capture `insertPos` *before* the async resolve fires and TRACK it
//     through transactions (see `trackInsertPosition`) — if the position
//     is deleted (roving block switch, surrounding text removed), the
//     insertion is DROPPED instead of landing in the wrong document
//   - on resolve, check `insertPos <= editor.state.doc.content.size` —
//     `insertContentAt` clamps silently when the offset is past doc end,
//     so a stale offset would *not* surface via the existing try/catch
//   - on stale offset, fall back to plain-text insertion at the *current*
//     cursor (`insertContent`) instead of the captured `insertPos`
//
// The helper accepts:
//   - `matchItem(items, text)` — per-picker exact-match predicate
//     (block-link recognises `aliasText === text` in addition to label
//     matching; at-tag and block-ref only check label).
//   - `tokenFor(id)` — builds the TipTap content node descriptor for the
//     token (`{ type: 'tag_ref'|'block_link'|'block_ref', attrs: { id } }`).
//   - `onCreate?(text)` — optional "no match, create new" branch
//     (at-tag and block-link have it; block-ref does not).
//
// Branch coverage:
//   - happy path (exact match → token inserted),
//   - onCreate path (no match, onCreate resolves → token inserted),
//   - plain-text fallback (no match, no onCreate),
//   - error fallback (`items` throws),
//   - stale `insertPos` fallback (each insertContentAt branch),
//   - editor destroyed mid-resolve (defensive early return).
// Covered by the existing per-picker `__tests__/*-picker.test.ts` suites
// + the focused `__tests__/picker-plugin.test.ts` cases.
export interface ResolveAndInsertPickerTokenOptions {
  /** Live editor reference. */
  editor: Editor
  /** The text the user typed inside the trigger (e.g. `myTag`, `My Page`). */
  text: string
  /** Captured insertion offset (the original `range.from`). */
  insertPos: number
  /** Async items lookup. */
  items: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Per-picker exact-match predicate. Returns the matched item, or `undefined`. */
  matchItem: (items: PickerItem[], text: string) => PickerItem | undefined
  /** Builds the TipTap content descriptor for the resolved id. */
  tokenFor: (id: string) => Record<string, unknown>
  /** Optional "no match, create new" branch — returns the new resolved id. */
  onCreate?: ((text: string) => Promise<string>) | undefined
  /** Component name passed to `logger.warn` (e.g. `'BlockLinkPicker'`). */
  loggerComponent: string
  /** Error message used when the `items` callback throws. */
  errorMessage: string
}

export async function resolveAndInsertPickerToken({
  editor,
  text,
  insertPos,
  items,
  matchItem,
  tokenFor,
  onCreate,
  loggerComponent,
  errorMessage,
}: ResolveAndInsertPickerTokenOptions): Promise<void> {
  // Track the captured offset through every transaction so a roving
  // block switch (full-doc replace) or removal of the surrounding text
  // is detected — `tracked.pos === null` means the insertion has nowhere
  // legitimate to land and must be dropped, NOT applied to whatever
  // document is mounted now.
  const tracked = trackInsertPosition(editor, insertPos)

  // InsertContentAt clamps silently when the offset is past the doc's end
  // (only reachable when tracking is unavailable — mapped positions are
  // always in range), so the existing try/catch never fires on that path.
  // Validate before each insertContentAt call; on a stale offset, fall
  // back to plain text at the current cursor.
  const isStale = (pos: number) => pos > editor.state.doc.content.size
  const insertPlainAtCursor = () => {
    editor.chain().focus().insertContent(text).run()
  }
  const isGone = () => {
    if (tracked.pos !== null) return false
    logger.warn(
      loggerComponent,
      'insert position deleted while resolve was in flight (block switched or text removed); dropping insertion',
      { text, insertPos },
    )
    return true
  }

  try {
    const resolved = await items(text)
    if (editor.isDestroyed) return
    const exactMatch = matchItem(resolved, text)
    if (exactMatch) {
      if (isGone()) return
      const pos = tracked.pos ?? insertPos
      if (isStale(pos)) {
        logger.warn(
          loggerComponent,
          'insertPos stale after items resolved; falling back to plain text at cursor',
          { text, insertPos, docSize: editor.state.doc.content.size },
        )
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(pos, tokenFor(exactMatch.id)).run()
    } else if (onCreate) {
      // Bail BEFORE the create IPC — minting a page/tag whose token can no
      // longer be inserted would leave an orphan entity behind.
      if (isGone()) return
      const newId = await onCreate(text)
      if (editor.isDestroyed) return
      if (isGone()) return
      const pos = tracked.pos ?? insertPos
      if (isStale(pos)) {
        logger.warn(
          loggerComponent,
          'insertPos stale after onCreate resolved; falling back to plain text at cursor',
          { text, insertPos, docSize: editor.state.doc.content.size },
        )
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(pos, tokenFor(newId)).run()
    } else {
      // No match and no onCreate — re-insert as plain text
      if (isGone()) return
      const pos = tracked.pos ?? insertPos
      if (isStale(pos)) {
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(pos, text).run()
    }
  } catch (err) {
    logger.warn(loggerComponent, errorMessage, { text }, err)
    if (editor.isDestroyed) return
    // On error, re-insert as plain text so the user doesn't lose content —
    // unless the position is gone (the text belongs to another block now).
    if (isGone()) return
    const pos = tracked.pos ?? insertPos
    if (isStale(pos)) {
      insertPlainAtCursor()
      return
    }
    editor.chain().focus().insertContentAt(pos, text).run()
  } finally {
    tracked.stop()
  }
}

// ── ──────────────────────────────────────────────────────────────
//
// Shared `isCreate` selection path for the Suggestion-command pickers
// (AtTagPicker `@`, BlockLinkPicker `[[`). Two races are closed here:
//
//   1. The trigger range is deleted SYNCHRONOUSLY, before the create IPC
//      is awaited (mirroring slash-command). Deleting the range breaks the
//      Suggestion match, so the popup exits immediately and a second
//      Enter / row click cannot re-fire the create while it is in flight
//      (double page/tag creation + double deleteRange corruption).
//   2. The insertion offset is tracked through transactions (see
//      `trackInsertPosition`), so a roving block switch mid-create drops
//      the token instead of running stale offsets against another block's
//      document.
//
// On create failure the captured trigger text is re-inserted at the
// tracked position so the user's typing isn't lost.
export interface CreatePickerTokenFromCommandOptions {
  /** Live editor reference. */
  editor: Editor
  /** Suggestion command range covering the trigger char(s) + query. */
  range: { from: number; to: number }
  /** Label the new entity is created with (the picker item's label). */
  label: string
  /** Create IPC — resolves the new entity's id. */
  onCreate: (label: string) => Promise<string>
  /** Builds the TipTap content descriptor for the created id. */
  tokenFor: (id: string) => Record<string, unknown>
  /** Component name passed to the logger (e.g. `'AtTagPicker'`). */
  loggerComponent: string
  /** Error message used when `onCreate` rejects. */
  errorMessage: string
}

export function createPickerTokenFromCommand({
  editor,
  range,
  label,
  onCreate,
  tokenFor,
  loggerComponent,
  errorMessage,
}: CreatePickerTokenFromCommandOptions): void {
  // Capture the raw trigger text (e.g. `@projx`) BEFORE deleting it, so a
  // failed create can restore it. U+FFFC is textBetween's leaf placeholder
  // for non-text nodes (same convention as emoji-picker's allow gate).
  const triggerText = editor.state.doc.textBetween(range.from, range.to, undefined, '\uFFFC')
  editor.chain().focus().deleteRange(range).run()
  const tracked = trackInsertPosition(editor, range.from)

  onCreate(label)
    .then((newId) => {
      if (editor.isDestroyed) return
      const pos = tracked.pos
      if (pos === null) {
        logger.warn(
          loggerComponent,
          'insert position deleted while create was in flight (block switched or text removed); dropping token',
          { label },
        )
        return
      }
      editor
        .chain()
        .focus()
        .insertContentAt(pos, [tokenFor(newId), { type: 'text', text: ' ' }])
        .run()
    })
    .catch((err: unknown) => {
      logger.error(loggerComponent, errorMessage, undefined, err)
      if (editor.isDestroyed) return
      const pos = tracked.pos
      if (pos === null) return
      // Restore the trigger text so the user's typing isn't lost.
      editor.chain().focus().insertContentAt(pos, triggerText).run()
    })
    .finally(() => {
      tracked.stop()
    })
}
