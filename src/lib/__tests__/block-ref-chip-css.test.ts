/**
 * Regression guard for #4228 — the block-ref chip must bound its own
 * rendered WIDTH, independent of what string lands in the DOM.
 *
 * The resolve-store title is capped to one line / 60 chars at the seed
 * (`normalizeBlockRefTitle`, `@/lib/block-title`), but without an explicit
 * `white-space` + `max-width` bound a long single line still wraps under
 * the default `white-space: normal`, or grows the chip past its container.
 *
 * ## Which rule carries which half of the bound
 *
 * The WIDTH bound (`max-width`, plus `overflow: hidden` so nothing spills
 * past the chip's rounded box) belongs to `.block-ref-chip`.
 *
 * The single-line + ellipsis half CANNOT live there. `.block-ref-chip` is
 * `inline-flex`, and `text-overflow` applies only to a BLOCK container: a
 * bare text child of a flex container is wrapped in an ANONYMOUS flex item,
 * which no selector can reach, so `text-overflow` on the parent has no
 * effect on it and the chip hard-clips mid-glyph with no `…` marker. (That
 * is exactly how the declaration shipped inert while an earlier version of
 * this file asserted its spelling on `.block-ref-chip` and stayed green.)
 * Both chip renderers — `renderBlockRef`
 * (`@/components/RichContentRenderer/marks/blockRef.tsx`) and the TipTap
 * `BlockRef` NodeView (`@/editor/extensions/block-ref.ts`) — therefore put
 * the title in a real `.block-ref-chip-label` child, and that rule carries
 * `white-space` / `overflow` / `text-overflow` plus the `min-width: 0` a
 * flex item needs before it will shrink below its content width at all.
 *
 * So this file asserts each half against the rule that actually carries it.
 *
 * ## What this test can and cannot prove
 *
 * It CANNOT prove the chip is bounded on screen. happy-dom (like jsdom)
 * performs no layout — no box model, no line breaking, no overflow — so
 * `getBoundingClientRect()` is all zeros and computed style says nothing
 * about wrapping. This file therefore reads `src/index.css` as TEXT and
 * asserts on the rule's SPELLING (mirroring `editor-list-marker-css.test.ts`
 * / `theme-contrast.test.ts`). All it proves is that deleting the bounding
 * declarations trips a test. The REAL acceptance criterion — "a 60-char
 * chip renders on ONE line, clipped inside its container" — is an observed
 * behaviour and belongs in an e2e check running in a browser that lays out.
 *
 * Because it is a spelling pin, it is deliberately written to survive the
 * legitimate rewrites of that spelling instead of freezing one form of
 * words:
 *   - Tailwind's `truncate` utility IS
 *     `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`, and
 *     this rule already opens with an `@apply` list, so folding those three
 *     declarations into `@apply truncate` is the idiomatic tidy-up in this
 *     file's own house style — it satisfies all three of those assertions.
 *   - `max-width` is accepted as a literal length, as a design token
 *     (`var(--chip-max-width)`), or as an `@apply`ed `max-w-*` utility.
 *
 * What it does NOT accept is the bound going away.
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

/** Every utility named by every `@apply` directive in `rule`, flattened. */
function appliedUtilities(rule: string): string[] {
  return [...rule.matchAll(/@apply\s+([^;}]+)/g)].flatMap((m) =>
    (m[1] as string).trim().split(/\s+/),
  )
}

describe('.block-ref-chip bounded width (#4228)', () => {
  const chipRule = ruleFor('.block-ref-chip')
  const labelRule = ruleFor('.block-ref-chip-label')
  const chipApplied = appliedUtilities(chipRule)
  const labelApplied = appliedUtilities(labelRule)

  /**
   * The rule must express the bound either by spelling `pattern` out or by
   * `@apply truncate` (Tailwind's `truncate` expands to exactly the
   * overflow/ellipsis/nowrap trio, so it satisfies all three of those
   * assertions on its own). Always asserts (never vacuous) and prints the
   * rule text on failure, since which declarations are present IS the
   * subject.
   */
  function expectBoundedBy(
    selector: string,
    rule: string,
    applied: string[],
    pattern: RegExp,
    what: string,
  ): void {
    expect(
      applied.includes('truncate') || pattern.test(rule),
      `${selector} must set ${what} — spelled out, or via \`@apply truncate\`. Rule text:\n${rule}`,
    ).toBe(true)
  }

  it('sets white-space: nowrap on the label so a long single line cannot wrap the chip onto multiple lines', () => {
    expectBoundedBy(
      '.block-ref-chip-label',
      labelRule,
      labelApplied,
      /white-space:\s*nowrap/,
      'white-space: nowrap',
    )
  })

  it('sets overflow: hidden on the chip so content past max-width does not spill out of its box', () => {
    expectBoundedBy(
      '.block-ref-chip',
      chipRule,
      chipApplied,
      /overflow:\s*hidden/,
      'overflow: hidden',
    )
  })

  /**
   * The one that shipped inert. `text-overflow` needs a BLOCK container, so
   * asserting it on the `inline-flex` `.block-ref-chip` proved nothing about
   * whether an `…` ever renders. It has to sit on the label — and the label
   * has to be able to overflow in the first place, which a flex item only
   * does once `min-width: auto` is overridden.
   */
  it('sets text-overflow: ellipsis on the label, the block-level box it can actually apply to', () => {
    expectBoundedBy(
      '.block-ref-chip-label',
      labelRule,
      labelApplied,
      /text-overflow:\s*ellipsis/,
      'text-overflow: ellipsis',
    )
    expectBoundedBy(
      '.block-ref-chip-label',
      labelRule,
      labelApplied,
      /overflow:\s*hidden/,
      'overflow: hidden (text-overflow is inert without it)',
    )
    expect(
      /min-width:\s*0/.test(labelRule) || labelApplied.includes('min-w-0'),
      `.block-ref-chip-label must set \`min-width: 0\` — a flex item defaults to \`min-width: auto\` and will not shrink below its content width, so nothing ever overflows and the ellipsis never renders. Rule text:\n${labelRule}`,
    ).toBe(true)
  })

  it('sets an explicit max-width on the chip so it cannot grow past a fixed bound', () => {
    // `truncate` does NOT carry a width bound, so this arm never accepts it.
    const literalOrToken = /max-width:\s*(?:[\d.]+(?:rem|px|em|ch|%)|var\(\s*--[\w-]+)/
    expect(
      literalOrToken.test(chipRule) || chipApplied.some((u) => u.startsWith('max-w-')),
      `.block-ref-chip must set a max-width — a literal length, a \`var(--token)\`, or an \`@apply\`ed \`max-w-*\` utility. Rule text:\n${chipRule}`,
    ).toBe(true)
  })
})
