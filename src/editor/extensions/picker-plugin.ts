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
import type { PluginKey } from '@tiptap/pm/state'
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion'

import { logger } from '../../lib/logger'
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

// ── MAINT-203 ──────────────────────────────────────────────────────────────
//
// Shared async resolve-and-insert path for the 3 token-inserting pickers
// (AtTagPicker `#TAG`, BlockLinkPicker `[[ULID]]`, BlockRefPicker `((ULID))`).
//
// All three implement the same FE-M-15 race-condition guard:
//   - capture `insertPos` *before* the async resolve fires
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
  // FE-M-15: insertContentAt clamps silently when insertPos is past the
  // doc's end (e.g. user cleared/shrank the doc while the async resolve
  // was in flight), so the existing try/catch never fires on that path.
  // Validate before each insertContentAt(insertPos, ...) call; on a stale
  // offset, fall back to plain text at the current cursor.
  const isStale = () => insertPos > editor.state.doc.content.size
  const insertPlainAtCursor = () => {
    editor.chain().focus().insertContent(text).run()
  }

  try {
    const resolved = await items(text)
    if (editor.view?.isDestroyed) return
    const exactMatch = matchItem(resolved, text)
    if (exactMatch) {
      if (isStale()) {
        logger.warn(
          loggerComponent,
          'insertPos stale after items resolved; falling back to plain text at cursor',
          { text, insertPos, docSize: editor.state.doc.content.size },
        )
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(insertPos, tokenFor(exactMatch.id)).run()
    } else if (onCreate) {
      const newId = await onCreate(text)
      if (editor.view?.isDestroyed) return
      if (isStale()) {
        logger.warn(
          loggerComponent,
          'insertPos stale after onCreate resolved; falling back to plain text at cursor',
          { text, insertPos, docSize: editor.state.doc.content.size },
        )
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(insertPos, tokenFor(newId)).run()
    } else {
      // No match and no onCreate — re-insert as plain text
      if (isStale()) {
        insertPlainAtCursor()
        return
      }
      editor.chain().focus().insertContentAt(insertPos, text).run()
    }
  } catch (err) {
    logger.warn(loggerComponent, errorMessage, { text }, err)
    if (editor.view?.isDestroyed) return
    // On error, re-insert as plain text so the user doesn't lose content
    if (isStale()) {
      insertPlainAtCursor()
      return
    }
    editor.chain().focus().insertContentAt(insertPos, text).run()
  }
}
