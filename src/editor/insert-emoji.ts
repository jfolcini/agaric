/**
 * #286 — insert a native emoji into the live roving editor at the caret.
 *
 * Shared by the `/emoji` slash command (BlockTree) and any future emoji
 * surface that targets the block editor. Routes through the active-editor
 * registry (`getActiveEditor`) and the editor's own `insertContent` command
 * so the insertion joins the undo history — the same path the command
 * palette uses for `[[Page]]` links (see `active-editor.ts`, #82).
 *
 * Returns `true` when the emoji was inserted, `false` when there is no active
 * editor or the insertion threw (logged). Surfaces that don't target the
 * roving editor (page title, tag name) splice into their own element and
 * should not use this helper.
 */

import { logger } from '../lib/logger'
import { getActiveEditor } from './active-editor'

export function insertEmojiIntoActiveEditor(char: string): boolean {
  if (char.length === 0) return false
  // #1064 — `getActiveEditor()` is the liveness chokepoint (it nulls a
  // destroyed handle), so a dead registry entry reads as "no active editor"
  // and degrades cleanly here. The `isDestroyed` short-circuit is cheap
  // belt-and-suspenders against a destroy that races this call. Either way we
  // never reach the chain on a dead editor — the try/catch below stays as
  // defense-in-depth, not the dead-handle path.
  const editor = getActiveEditor()
  if (editor == null || editor.isDestroyed) {
    logger.warn('insert-emoji', 'no active editor for emoji insert', { char })
    return false
  }
  try {
    editor.chain().focus().insertContent(char).run()
    return true
  } catch (err) {
    logger.warn('insert-emoji', 'failed to insert emoji', { char }, err)
    return false
  }
}
