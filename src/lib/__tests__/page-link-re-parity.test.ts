import { describe, expect, it } from 'vitest'

import { HUMAN_PAGE_LINK_RE } from '../block-clipboard'

/**
 * #1920 — cross-language parity for the inbound wiki-link regex.
 *
 * `HUMAN_PAGE_LINK_RE` here mirrors the CANONICAL Rust source of the same name
 * in `src-tauri/src/commands/pages/markdown.rs` (pattern `\[\[([^\]\n]+?)\]\]`).
 * The matching Rust test is `page_link_re_parity_boundaries_1920`. This fixture
 * is intentionally IDENTICAL to the Rust one — any change to the pattern must be
 * mirrored in both places (and in both tests).
 */
describe('HUMAN_PAGE_LINK_RE cross-language parity (#1920)', () => {
  // `(input, expected inner (group-1) captures in order)` — same fixture as the
  // Rust `page_link_re_parity_boundaries_1920` test.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['[[A]]', ['A']],
    ['[[A B]]', ['A B']],
    ['[[A]] text [[B]]', ['A', 'B']],
    // Non-greedy: the first `]]` closes the match opened at the LAST `[[`.
    ['[[a[[b]]', ['a[[b']],
    // Empty `[[]]` does not match (body is one-or-more, `+?`).
    ['[[]]', []],
    // A newline inside the brackets prevents a match (body excludes `\n`).
    ['[[A\nB]]', []],
  ]

  for (const [input, expected] of cases) {
    it(`matches expected boundaries for ${JSON.stringify(input)}`, () => {
      // matchAll is safe with a /g regex (no shared lastIndex state leak).
      const got = [...input.matchAll(HUMAN_PAGE_LINK_RE)].map((m) => m[1])
      expect(got).toEqual([...expected])
    })
  }
})
