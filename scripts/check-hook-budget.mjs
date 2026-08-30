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

// Cap set 2026-08-30 (#4556) from the post-cleanup count of 155 hooks, plus
// ~10% headroom. Raising this requires deleting or justifying what it buys.
const HOOK_CAP = 170
const CONFIG = 'prek.toml'

const lines = readFileSync(CONFIG, 'utf8').split('\n')
const SKIP = /^(\[\[repos(\.hooks)?\]\]|repo\s*=|rev\s*=)/
const violations = []
let hooks = 0

for (let i = 0; i < lines.length; i++) {
  const id = /id = "([^"]+)"/.exec(lines[i])
  if (!id) continue
  hooks++
  // Walk up past the stanza headers, then over the contiguous comment block.
  let j = i
  while (j > 0 && SKIP.test(lines[j - 1].trim())) j--
  let hasWhy = false
  while (j > 0 && /^\s*#/.test(lines[j - 1])) {
    j--
    if (/^\s*# WHY:/.test(lines[j])) hasWhy = true
  }
  if (!hasWhy) violations.push(`${CONFIG}:${i + 1}: hook "${id[1]}" has no \`# WHY:\` line`)
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
