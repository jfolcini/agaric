/**
 * Regression guard for #2999 — the list-button marker/content split.
 *
 * `.ProseMirror li` always wraps its text in a block-level `<p>` (TipTap
 * `ListItem`'s schema is `paragraph block*`). Per the CSS list spec,
 * `list-style-position: inside` combined with a block-level first child in
 * the `<li>` forces the `::marker` onto its own line ABOVE that block
 * instead of beside its first line of text — so clicking the ordered/
 * unordered list button rendered the number/bullet on one line and the
 * typed content on a separate line below it. `list-style-position: outside`
 * keeps the marker in the item's margin box regardless of whether the
 * child is block or inline, which is immune to this split.
 *
 * This test reads `src/index.css` directly (mirroring the pattern in
 * `theme-contrast.test.ts`) rather than asserting on parsed CSSOM, since
 * jsdom does not perform layout and can't observe the actual line split.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const CSS_SOURCE = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

/** Extract a single top-level rule's declaration block by its selector. */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS_SOURCE)
  if (!m) throw new Error(`rule not found in index.css: ${selector}`)
  return m[1] as string
}

describe('editor list marker CSS (#2999)', () => {
  it.each(['.ProseMirror ul', '.ProseMirror ol'])(
    '%s does NOT use list-style-position: inside (splits the marker onto its own line above a block <p> child)',
    (selector) => {
      const rule = ruleFor(selector)
      expect(rule).not.toMatch(/\blist-inside\b/)
    },
  )

  it.each(['.ProseMirror ul', '.ProseMirror ol'])(
    '%s uses list-outside so the marker stays in the margin box regardless of the <li> child',
    (selector) => {
      const rule = ruleFor(selector)
      expect(rule).toMatch(/\blist-outside\b/)
    },
  )
})
