import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Pure, I/O-free detectors from the guard script. Importing does NOT trigger
// the filesystem scan (the CLI body is behind a direct-invocation check), so
// the fixture tests stay fast; the live-tree case calls `scanTree` explicitly.
// @ts-expect-error — no type declarations for the .mjs script.
import { findBareIconButtons, scanTree } from '../../scripts/check-bare-icon-buttons.mjs'

/**
 * Forward guard for the IconButton migration (#1089). A bare
 * `<Button size="icon*">` with NEITHER `aria-label` NOR `aria-hidden` ships an
 * icon-only button with no accessible name — exactly what the `IconButton`
 * primitive exists to prevent. This is a consistency guard, NOT a blanket
 * mandate: decorative (`aria-hidden`) triggers and `{...props}`-forwarding
 * wrappers are intentionally allowed.
 */
describe('findBareIconButtons (detector)', () => {
  it('flags a bare icon Button with no aria-label / aria-hidden', () => {
    const src = `<Button variant="ghost" size="icon-sm" onClick={go}><X /></Button>`
    expect(findBareIconButtons(src)).toHaveLength(1)
  })

  it('flags every icon size variant (icon, icon-xs, icon-sm, icon-lg)', () => {
    for (const size of ['icon', 'icon-xs', 'icon-sm', 'icon-lg']) {
      const src = `<Button size="${size}"><X /></Button>`
      expect(findBareIconButtons(src), size).toHaveLength(1)
    }
  })

  it('does NOT flag an icon Button that has an aria-label', () => {
    const src = `<Button size="icon-sm" aria-label="Close"><X /></Button>`
    expect(findBareIconButtons(src)).toHaveLength(0)
  })

  it('does NOT flag a decorative aria-hidden / tabIndex={-1} icon Button', () => {
    const src = `<Button size="icon-xs" aria-hidden tabIndex={-1}><H /></Button>`
    expect(findBareIconButtons(src)).toHaveLength(0)
  })

  it('does NOT flag an icon Button that forwards {...props} (may carry the name)', () => {
    const src = `<Button size="icon" ref={ref} {...props}><X /></Button>`
    expect(findBareIconButtons(src)).toHaveLength(0)
  })

  it('does NOT flag a non-icon (text) Button', () => {
    const src = `<Button variant="outline" size="sm" onClick={go}>Today</Button>`
    expect(findBareIconButtons(src)).toHaveLength(0)
  })

  // Regression: a naive `/<Button[^>]*>/` regex truncates the tag at the first
  // `>` inside an arrow-function prop, missing a trailing aria-label and
  // false-FAILing the build. The brace-aware parser must see the whole tag.
  it('handles an arrow-function prop with a ">" before the aria-label', () => {
    const src = [
      `<Button`,
      `  size="icon-xs"`,
      `  onClick={() => startEdit(id)}`,
      `  aria-label={t('edit')}`,
      `>`,
      `  <Pencil />`,
      `</Button>`,
    ].join('\n')
    expect(findBareIconButtons(src)).toHaveLength(0)
  })

  it('does NOT confuse <ButtonGroup> / <ButtonRow> for <Button>', () => {
    const src = `<ButtonGroup size="icon"><span /></ButtonGroup>`
    expect(findBareIconButtons(src)).toHaveLength(0)
  })

  it('reports the 1-based start line of the violation', () => {
    const src = `line1\nline2\n<Button size="icon"><X /></Button>`
    expect(findBareIconButtons(src)).toEqual([{ line: 3 }])
  })
})

describe('bare icon Button guard (live src/ tree)', () => {
  it('has no bare icon-only Buttons without an accessible name', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const srcRoot = join(here, '..')
    const violations = scanTree(srcRoot)
    expect(violations).toEqual([])
  })
})
