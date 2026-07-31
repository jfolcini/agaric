#!/usr/bin/env node
// #3350 — picks the mutation modules a pull request actually touches.
//
// ─── Why ─────────────────────────────────────────────────────────────────
//
// The mutation signal is currently stale-and-batched: it arrives on a weekly
// schedule, hours after a batch of unrelated commits, so a survivor cannot be
// attributed to a change and nobody is in context to act on it. #3350 calls
// moving it to fresh-and-attributable the highest-value change in the issue —
// same information, delivered when it is cheap to act on.
//
// The mechanism is scope, not speed: a PR that touches `tree-utils.ts` needs
// `tree-utils` mutated and nothing else, which is a couple of hundred mutants
// and a couple of minutes rather than the whole sweep. Most PRs touch no
// enrolled module at all and the lane does nothing.
//
// ─── Bounded by construction ─────────────────────────────────────────────
//
// `--max` caps how many modules a single PR run will mutate. This is not a
// nicety: without it, a PR editing `stryker.modules.mjs` or doing a
// repo-wide rename selects EVERY module and turns a per-PR lane into the
// hours-long sweep #3350 explicitly refuses to put in front of a merge.
// Overflow is reported, not silently dropped — the scheduled lane still
// covers everything, so the honest statement is "these were skipped here".
//
// Modules whose SOURCE changed are selected ahead of modules where only a
// test file changed: a source edit is the thing that can weaken an
// invariant, while a test edit is usually someone strengthening one.
//
// ─── Explicitly NOT gating ───────────────────────────────────────────────
//
// Nothing here returns a pass/fail verdict, and the workflow that calls it
// never fails on mutation score. This script only answers "which modules".
//
// Usage:
//   node scripts/select-mutation-modules.mjs --changed-from <file>  [--max N]
//   node scripts/select-mutation-modules.mjs --changed <path> [--changed <path>…]
//   node scripts/select-mutation-modules.mjs --self-test
//
// `--changed-from` reads newline-separated paths (i.e. `git diff --name-only`
// output) and treats `-` as stdin.
//
// Output: a JSON object on stdout —
//   { "selected": [names…], "skipped": [names…], "reason": "…" }
// or, with `--markdown`, the same selection rendered as the Markdown
// paragraph the step summary / PR comment opens with (kept here rather than
// as a shell one-liner in the workflow so it is covered by this script's own
// fixture suite). Either way, when `$GITHUB_OUTPUT` is set,
// `modules=<space-separated>` and `count=<n>` are appended to it for the
// workflow to branch on.
//
// Exit: 0 always when the arguments parse (an empty selection is a normal,
// expected answer), 2 for bad usage / self-test failure.

import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'

import { MODULE_NAMES, MODULES } from '../stryker.modules.mjs'

// A single PR run mutates at most this many modules. Chosen from measured
// per-module cost: the enrolled modules run between ~5s and ~66s each on a
// developer machine and roughly 1.5–1.8x that on a runner, so four is the
// point where the worst realistic case still lands in minutes rather than
// tens of minutes. Raise it only with numbers.
export const DEFAULT_MAX_MODULES = 4

/**
 * Pure selection. `changedFiles` are repo-relative paths exactly as
 * `git diff --name-only` prints them.
 */
export function selectModules({ changedFiles, modules = MODULES, max = DEFAULT_MAX_MODULES }) {
  const changed = new Set(changedFiles.map((f) => f.trim()).filter((f) => f.length > 0))

  const srcHits = []
  const testHits = []
  for (const name of Object.keys(modules)) {
    const mod = modules[name]
    if (changed.has(mod.src)) srcHits.push(name)
    else if ((mod.tests ?? []).some((t) => changed.has(t))) testHits.push(name)
  }

  // Deterministic within each tier; the tiers themselves carry the priority.
  const ordered = [...srcHits.toSorted(), ...testHits.toSorted()]
  const selected = ordered.slice(0, max)
  const skipped = ordered.slice(max)

  let reason
  if (ordered.length === 0) {
    reason = `no mutation-enrolled module was touched (${MODULE_NAMES.length} module(s) enrolled in stryker.modules.mjs)`
  } else if (skipped.length === 0) {
    reason = `${selected.length} enrolled module(s) touched by this diff`
  } else {
    reason = `${ordered.length} enrolled module(s) touched; capped at ${max} to keep this lane in minutes — the rest are covered by the weekly scheduled sweep`
  }

  return { selected, skipped, reason }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Renders a selection as the Markdown paragraph the PR comment opens with.
 * Exported so the wording is testable; the workflow shells out for it rather
 * than embedding JS in a `run:` block.
 */
export function renderSelection({ selected, skipped, reason }) {
  const parts = [`Selection: ${reason}`]
  if (selected.length > 0) parts.push('', `Mutated: \`${selected.join('`, `')}\``)
  if (skipped.length > 0)
    parts.push('', `Skipped here (the weekly sweep covers them): \`${skipped.join('`, `')}\``)
  return parts.join('\n')
}

function parseArgs(argv) {
  const changedFiles = []
  let max = DEFAULT_MAX_MODULES
  let markdown = false
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--markdown': {
        markdown = true
        break
      }
      case '--changed': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--changed needs a path')
        changedFiles.push(v)
        break
      }
      case '--changed-from': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--changed-from needs a path (or `-` for stdin)')
        const text = readFileSync(v === '-' ? 0 : v, 'utf8')
        changedFiles.push(...text.split('\n'))
        break
      }
      case '--max': {
        const v = Number(argv[++i])
        if (!Number.isInteger(v) || v < 1) throw new Error('--max needs a positive integer')
        max = v
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${argv[i]}`)
      }
    }
  }
  return { changedFiles, max, markdown }
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`select-mutation-modules: ${err.message}`)
    process.exit(2)
  }

  const result = selectModules(args)
  console.log(args.markdown ? renderSelection(result) : JSON.stringify(result))

  const out = process.env.GITHUB_OUTPUT
  if (out) {
    // Space-separated so the workflow can pass it straight to
    // `scripts/run-mutation.mjs`, which takes module names as argv.
    appendFileSync(
      out,
      `modules=${result.selected.join(' ')}\ncount=${result.selected.length}\n`,
      'utf8',
    )
  }
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const fixture = {
    alpha: { src: 'src/lib/alpha.ts', tests: ['src/lib/__tests__/alpha.test.ts'] },
    beta: { src: 'src/lib/beta.ts', tests: ['src/lib/__tests__/beta.test.ts'] },
    gamma: { src: 'src/lib/gamma.ts', tests: ['src/lib/__tests__/gamma.test.ts'] },
    delta: { src: 'src/lib/delta.ts', tests: ['src/lib/__tests__/delta.test.ts'] },
    epsilon: { src: 'src/lib/epsilon.ts', tests: ['src/lib/__tests__/epsilon.test.ts'] },
  }

  // 1. The overwhelmingly common case: a PR that touches nothing enrolled
  //    selects nothing. If this ever returns a non-empty list, every PR in
  //    the repo starts paying for a mutation run.
  {
    const r = selectModules({
      changedFiles: ['src/components/Foo.tsx', 'docs/BUILD.md'],
      modules: fixture,
    })
    if (r.selected.length === 0) ok('an unrelated diff selects nothing')
    else fail('an unrelated diff selects nothing', JSON.stringify(r))
  }

  // 2. A source change selects exactly its module.
  {
    const r = selectModules({ changedFiles: ['src/lib/beta.ts'], modules: fixture })
    if (r.selected.join(',') === 'beta') ok('a source change selects exactly its module')
    else fail('a source change selects exactly its module', JSON.stringify(r))
  }

  // 3. A test-only change selects it too — a weakened test is precisely what
  //    mutation testing is for, and it is invisible to every other check.
  {
    const r = selectModules({
      changedFiles: ['src/lib/__tests__/gamma.test.ts'],
      modules: fixture,
    })
    if (r.selected.join(',') === 'gamma') ok('a test-only change still selects its module')
    else fail('a test-only change still selects its module', JSON.stringify(r))
  }

  // 4. Source beats tests in the ordering, so when the cap bites it is the
  //    test-only modules that get dropped.
  {
    const r = selectModules({
      changedFiles: [
        'src/lib/__tests__/alpha.test.ts',
        'src/lib/__tests__/beta.test.ts',
        'src/lib/gamma.ts',
        'src/lib/delta.ts',
      ],
      modules: fixture,
      max: 2,
    })
    if (r.selected.join(',') === 'delta,gamma' && r.skipped.join(',') === 'alpha,beta')
      ok('source-changed modules outrank test-only ones under the cap')
    else fail('source-changed modules outrank test-only ones under the cap', JSON.stringify(r))
  }

  // 5. THE CAP HOLDS. A diff touching everything — a repo-wide rename, or an
  //    edit to `stryker.modules.mjs` itself — must not turn the per-PR lane
  //    into the hours-long sweep #3350 refuses to put in front of a merge.
  {
    const everything = Object.values(fixture).flatMap((m) => m.tests.concat(m.src))
    const r = selectModules({ changedFiles: everything, modules: fixture, max: 4 })
    if (r.selected.length === 4 && r.skipped.length === 1 && /capped at 4/.test(r.reason))
      ok('a diff touching every module is capped, and says so (#3350)')
    else fail('a diff touching every module is capped, and says so (#3350)', JSON.stringify(r))
  }

  // 6. Determinism: the same diff in a different argv order selects the same
  //    modules, so a re-run does not silently mutate a different set.
  {
    const files = ['src/lib/delta.ts', 'src/lib/alpha.ts', 'src/lib/gamma.ts']
    const a = selectModules({ changedFiles: files, modules: fixture, max: 2 })
    const b = selectModules({ changedFiles: files.toReversed(), modules: fixture, max: 2 })
    if (a.selected.join(',') === b.selected.join(',')) ok('selection is order-independent')
    else fail('selection is order-independent', `${a.selected} vs ${b.selected}`)
  }

  // 7. Blank lines (a trailing newline in `git diff --name-only` output) are
  //    not paths and must not match a module with an empty `src`.
  {
    const r = selectModules({ changedFiles: ['', '  ', '\n'], modules: fixture })
    if (r.selected.length === 0) ok('blank lines from git output select nothing')
    else fail('blank lines from git output select nothing', JSON.stringify(r))
  }

  // 8. The Markdown rendering names the modules and says what was skipped.
  //    A PR comment that only said "3 modules touched" would be a notification
  //    rather than information, which is the failure mode #3350 is about.
  {
    const r = selectModules({
      changedFiles: Object.values(fixture).map((m) => m.src),
      modules: fixture,
      max: 2,
    })
    const md = renderSelection(r)
    if (
      r.selected.every((n) => md.includes(`\`${n}\``)) &&
      r.skipped.every((n) => md.includes(`\`${n}\``)) &&
      /Skipped here/.test(md)
    )
      ok('the Markdown selection names both the mutated and the skipped modules')
    else fail('the Markdown selection names both the mutated and the skipped modules', md)

    const empty = renderSelection(selectModules({ changedFiles: ['docs/x.md'], modules: fixture }))
    if (!/Mutated:|Skipped here/.test(empty))
      ok('an empty selection renders no empty Mutated/Skipped lists')
    else fail('an empty selection renders no empty Mutated/Skipped lists', empty)
  }

  // 9. Against the REAL config, so the guard is not vacuous: the paths this
  //    script matches on are the same strings `stryker.modules.mjs` declares.
  {
    const realSrc = MODULES[MODULE_NAMES[0]].src
    const r = selectModules({ changedFiles: [realSrc] })
    if (r.selected.join(',') === MODULE_NAMES[0])
      ok(`the real config selects '${MODULE_NAMES[0]}' from its own src path`)
    else fail('the real config selects a module from its own src path', JSON.stringify(r))
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) runSelfTest()
  else main(argv)
}
