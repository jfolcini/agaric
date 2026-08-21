/**
 * Regression guard for #4228 — the `.block-ref-chip` rule must bound its
 * own rendered WIDTH, independent of what string lands in the DOM.
 *
 * The resolve-store title is capped to one line / 60 chars at the seed
 * (`normalizeBlockRefTitle`, `@/lib/block-title`), but without an explicit
 * `white-space` + `max-width` bound a long single line still wraps under
 * the default `white-space: normal`, or grows the chip past its container.
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
  const rule = ruleFor('.block-ref-chip')
  const applied = appliedUtilities(rule)
  // Tailwind `truncate` expands to exactly the overflow/ellipsis/nowrap trio,
  // so applying it satisfies all three of those assertions on its own.
  const truncateApplied = applied.includes('truncate')

  /**
   * The rule must express the bound either by spelling `pattern` out or by
   * `@apply truncate`. Always asserts (never vacuous) and prints the rule
   * text on failure, since which declarations are present IS the subject.
   */
  function expectBoundedBy(pattern: RegExp, what: string): void {
    expect(
      truncateApplied || pattern.test(rule),
      `.block-ref-chip must set ${what} — spelled out, or via \`@apply truncate\`. Rule text:\n${rule}`,
    ).toBe(true)
  }

  it('sets white-space: nowrap so a long single line cannot wrap the chip onto multiple lines', () => {
    expectBoundedBy(/white-space:\s*nowrap/, 'white-space: nowrap')
  })

  it('sets overflow: hidden so content past max-width does not spill out of the chip', () => {
    expectBoundedBy(/overflow:\s*hidden/, 'overflow: hidden')
  })

  it('sets text-overflow: ellipsis so truncated overflow is visually marked', () => {
    expectBoundedBy(/text-overflow:\s*ellipsis/, 'text-overflow: ellipsis')
  })

  it('sets an explicit max-width so the chip cannot grow past a fixed bound', () => {
    // `truncate` does NOT carry a width bound, so this arm never accepts it.
    const literalOrToken = /max-width:\s*(?:[\d.]+(?:rem|px|em|ch|%)|var\(\s*--[\w-]+)/
    expect(
      literalOrToken.test(rule) || applied.some((u) => u.startsWith('max-w-')),
      `.block-ref-chip must set a max-width — a literal length, a \`var(--token)\`, or an \`@apply\`ed \`max-w-*\` utility. Rule text:\n${rule}`,
    ).toBe(true)
  })
})
