#!/usr/bin/env node
// #4556 — the hook population is capped, and this is the cap.
//
// The population reached 184 hooks, 42% of them self-tests, and `guards`
// became the single most frequent commit scope in the repo. Cleaning that up
// once is worthless if it regrows; this is the ratchet that makes regrowth a
// deliberate, reviewed act instead of an accumulation.
//
// It checks two things and nothing else:
//   1. the number of hooks in prek.toml is at or under HOOK_CAP;
//   2. every hook carries a `# WHY:` line in the comment block above it.
//
// (2) is PRESENCE ONLY. It never reads what the line says. Grading the prose
// would make this a parser, and a parser is the one thing this file must not
// be — see below.
//
// WHY THIS SCRIPT HAS NO SELF-TEST, DELIBERATELY.
// #4556's own corollary is that a guard needing its own guard is a smell, and
// it applies here first. This script parses nothing: it counts a fixed string
// and looks for a fixed prefix. It has no fixtures, no baseline, no alias
// resolution, no AST. It cannot fail OPEN silently — the only ways it can be
// wrong are a wrong count or a spurious violation, and both are visible in its
// own output the first time anyone runs it. A self-test here would be a third
// level of meta guarding a `grep`. Do not add one.
//
// Raising HOOK_CAP is a one-line diff, on purpose: a reviewer has to approve
// the number going up, and the commit that does it is the record of why.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Cap set 2026-08-30 (#4556) from the post-cleanup count of 158 hooks (184
// before, 27 removed and `hook-budget` itself added; set-differenced on ids
// against origin/main, not eyeballed off the diff, because three stanzas in
// that diff are RELOCATIONS and a `-`/`+` count reads them as churn). That
// leaves 12 of headroom, 7.6%. Raising this requires deleting or justifying
// what it buys.
const HOOK_CAP = 170
// Anchored on this file's own location, not the cwd: prek invokes hooks from
// the repo root today, but nothing in the hook contract guarantees it, and the
// sibling change in this same commit adds the identical anchor to
// `file-mutation-survivors.mjs` for exactly that reason.
const CONFIG_PATH = join(import.meta.dirname, '..', 'prek.toml')
const CONFIG = 'prek.toml' // what the error messages name

const lines = readFileSync(CONFIG_PATH, 'utf8').split('\n')
// `hooks = [` is in here because a `[[repos]]` stanza can open its hooks as a
// MULTI-LINE array; without it the walk-up stops on that line and reports a
// spurious violation naming the first entry.
//
// ANCHORED to end-of-line, which is the whole point. Unanchored, it also
// matched the ONE-LINE form `hooks = [{ id = "x" }]` — so two adjacent
// `[[repos]]` blocks in that form with no blank line between them let the
// walk-up step over the first hook ENTIRELY and credit the second with the
// first's `# WHY:`. That is a silent fail-open, not a misdirection, and it
// was introduced by the fix for the multi-line case above. Demonstrated on a
// scratch tree: two such blocks, only the first explained, reported
// "2/170 hooks, all with a `# WHY:` line" and exited 0.
const SKIP = /^(\[\[repos(\.hooks)?\]\]|repo\s*=|rev\s*=|hooks\s*=\s*\[\s*$)/
const violations = []
let hooks = 0

for (let i = 0; i < lines.length; i++) {
  // BOTH TOML string forms, and `matchAll` rather than `exec`: keying on the
  // literal `id = "` alone let a single-quoted id (a TOML literal string,
  // which `taplo fmt` does NOT rewrite to a basic string) slip past both the
  // count and the WHY check — an unbudgeted, unexplained hook running on every
  // commit while this script printed a green line. A silent fail-open is the
  // one failure mode the no-self-test argument in the header claims this
  // script cannot have, so it must not have it.
  // Skip comment lines outright, require a word boundary before `id`, and
  // tolerate any spacing around `=`. Hardcoding single spaces was the THIRD
  // silent fail-open found in this one script: `id  = "x"` and `id="x"` are
  // both valid TOML and were neither counted nor WHY-checked, while the
  // script printed a green line. `taplo fmt --check` normalises the spacing
  // today, but that is another hook's property, not this one's, and the
  // header claims this script cannot fail open silently.
  // Without the first, a commented-out stanza (`# id = "foo"`) counts against
  // the cap and can emit a spurious WHY violation — the population becoming
  // sensitive to PROSE, in a file that is mostly prose. Without the second,
  // a key ending in `id` after a WORD character (`uuid`, `build_id`) counts as
  // a hook. Note what the boundary does NOT buy: `hook-id = "x"` still matches,
  // because `-` is not a word character. That direction over-counts, i.e. fails
  // CLOSED, so it is not a hole — but the earlier version of this comment
  // claimed the boundary excluded "any key ending in id", which is more than
  // it does, in a header that is otherwise careful about exactly this.
  //
  // The `"?` pair accepts a TOML QUOTED KEY. `"id" = "x"` is valid TOML, prek
  // accepts it, and `taplo fmt` does not unquote keys — so such a hook was
  // neither counted against the cap nor WHY-checked while this script printed
  // its green line. Demonstrated on a scratch tree: a lone quoted-key hook
  // reported "0/170 hooks" and exited 0.
  if (lines[i].trimStart().startsWith('#')) continue
  const ids = [...lines[i].matchAll(/\b"?id"?\s*=\s*(?:"([^"]+)"|'([^']+)')/g)].map(
    (m) => m[1] ?? m[2],
  )
  if (ids.length === 0) continue
  hooks += ids.length
  // ONE id per line, because the `# WHY:` walk below is per-LINE: two inline
  // hooks sharing a line would share one WHY and both count as explained.
  // That is the same fail-open shape as the quote-form bug above, so it gets
  // the same treatment rather than a note. No line in prek.toml does this
  // today; the point is that none can start to.
  if (ids.length > 1) {
    violations.push(
      `${CONFIG}:${i + 1}: ${ids.length} hook ids on one line (${ids.join(', ')}) — ` +
        'put each on its own line so each carries its own `# WHY:`',
    )
    continue
  }
  // Walk up past the stanza headers, then over the contiguous comment block.
  let j = i
  while (j > 0 && SKIP.test(lines[j - 1].trim())) j--
  let hasWhy = false
  while (j > 0 && /^\s*#/.test(lines[j - 1])) {
    j--
    if (/^\s*# WHY:/.test(lines[j])) hasWhy = true
  }
  if (!hasWhy) {
    for (const id of ids) {
      violations.push(`${CONFIG}:${i + 1}: hook "${id}" has no \`# WHY:\` line`)
    }
  }
}

let failed = false
if (hooks > HOOK_CAP) {
  console.error(`${CONFIG}:1: ${hooks} hooks, cap is ${HOOK_CAP} (#4556).
  Fix: delete a hook, or merge it into one that already covers the same
  invariant. Raising HOOK_CAP in scripts/check-hook-budget.mjs is a
  reviewed one-line diff — say in the PR body what the new hook buys and
  which hooks you checked it does not overlap (AGENTS.md, "Guards earn
  their keep").`)
  failed = true
}
if (violations.length > 0) {
  const list = violations.map((v) => `  ${v}`).join('\n')
  console.error(`${violations.length} hook(s) with no \`# WHY:\` line (#4556):
${list}
  Fix: add one comment line immediately above the hook, in the form
  \`# WHY: <defect class> — <#issue or session log where it occurred>\`.
  Presence is checked, never wording.`)
  failed = true
}

if (failed) process.exit(1)
console.log(`hook budget OK: ${hooks}/${HOOK_CAP} hooks, all with a \`# WHY:\` line`)
