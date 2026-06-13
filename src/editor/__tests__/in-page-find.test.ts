/**
 * Smoke test for the in-page-find extension stub (T2 / #1023, PEND-52).
 *
 * `InPageFindExtension` is an INTENTIONAL no-op: Agaric uses a roving editor
 * (one ProseMirror instance per focused block), so a cross-block find can't be
 * a single `DecorationSet`. The matcher + highlighter live in
 * `src/lib/in-page-find/` (CSS.highlights). The extension exists only to
 * reserve a slot for future editor-internal find affordances.
 *
 * These assertions document the stub so an accidental future
 * `addProseMirrorPlugins` (which would change keystroke routing) is caught.
 */

import { describe, expect, it } from 'vitest'

import { InPageFindExtension, inPageFindPluginKey } from '../extensions/in-page-find'

describe('InPageFindExtension (intentional stub)', () => {
  it('is an Extension named "inPageFind"', () => {
    expect(InPageFindExtension.type).toBe('extension')
    expect(InPageFindExtension.name).toBe('inPageFind')
  })

  it('attaches NO ProseMirror plugins yet (the matcher lives outside the editor)', () => {
    // No `addProseMirrorPlugins` on the config — adding one later is the
    // documented extension point, and would flip this assertion.
    expect(InPageFindExtension.config.addProseMirrorPlugins).toBeUndefined()
  })

  it('reserves a plugin key for future editor-internal find affordances', () => {
    expect(inPageFindPluginKey).toBeDefined()
  })

  it('declares no keyboard shortcuts (does not touch the keystroke hot path)', () => {
    expect(InPageFindExtension.config.addKeyboardShortcuts).toBeUndefined()
  })
})
