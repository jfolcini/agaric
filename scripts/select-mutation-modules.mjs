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
// ─── Saying how much of the diff this covers (#3691) ─────────────────────
//
// The rendered comment used to be "Selection: 1 enrolled module(s) touched"
// followed by a table whose bottom row said **All modules 100.0%**. On #3685
// that was literally true of the two lines it mutated and read as a statement
// about the PR: ~46 lines of new application logic across five unenrolled
// files drew no mutation signal at all, and nothing in the comment said so.
// 21 modules are enrolled while the frontend has far more source files than
// that, so "this diff touched something unenrolled" is the normal case, not
// the edge case — and the two scopes diverge most exactly when a PR adds new,
// unenrolled logic, which is when a reviewer would most want to know.
//
// So the selection paragraph now also reports the diff-relative scope: how
// many changed source files (and lines) the mutation run actually reached,
// and names the ones it did not. The principle is the one this script's
// `--max` cap already states in its own header — bounded coverage must say
// what it dropped, because silent truncation reads as "covered everything".
// It was applied to the cap the authors built and not to non-enrollment,
// which is the larger and far more common gap.
//
// Line counts come from `git diff --numstat` when the caller supplies it;
// `--changed-from` accepts BOTH `--name-only` and `--numstat` output and
// falls back to file counts when only names are available, so no existing
// caller breaks and the richer input is opt-in.
//
// Usage:
//   node scripts/select-mutation-modules.mjs --changed-from <file>  [--max N]
//   node scripts/select-mutation-modules.mjs --changed <path> [--changed <path>…]
//
// `--changed-from` reads newline-separated paths (i.e. `git diff --name-only`
// or `git diff --numstat` output) and treats `-` as stdin.
//
// Output: a JSON object on stdout —
//   { "selected": [names…], "skipped": [names…], "reason": "…", "coverage": {…} }
// or, with `--markdown`, the same selection rendered as the Markdown
// paragraph the step summary / PR comment opens with (kept here rather than
// as a shell one-liner in the workflow). Either way, when `$GITHUB_OUTPUT` is
// set,
// `modules=<space-separated>` and `count=<n>` are appended to it for the
// workflow to branch on.
//
// Exit: 0 always when the arguments parse (an empty selection is a normal,
// expected answer), 2 for bad usage.

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
 * `git diff --name-only` prints them, or `git diff --numstat` triples — the
 * path is extracted either way (#3691), so switching the workflow to numstat
 * for line counts cannot silently stop selecting modules.
 */
export function selectModules({ changedFiles, modules = MODULES, max = DEFAULT_MAX_MODULES }) {
  const entries = changedFiles
    .map((f) => (typeof f === 'string' ? parseChangedEntry(f) : f))
    .filter((f) => f !== null)
  const changed = new Set(entries.map((f) => f.path))

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

  return {
    selected,
    skipped,
    reason,
    coverage: diffCoverage({ changedFiles: entries, selected, modules }),
  }
}

// ---------------------------------------------------------------------------
// Diff-relative coverage (#3691)
// ---------------------------------------------------------------------------

/**
 * A changed path that Stryker could in principle mutate.
 *
 * Frontend TS under `src/` only: `src-tauri/` is Rust (a different lane
 * entirely), and `e2e/` is Playwright. Nothing here claims these SHOULD be
 * enrolled — the denominator is "source this diff changed", so that the
 * numerator can be honest about being a slice of it.
 */
const SOURCE_RE = /^src\/.+\.(?:ts|tsx)$/
// Tests are excluded from the denominator: a changed test file is not code a
// mutant can be planted in, and when it belongs to an enrolled module it
// already selects that module above. Counting them would flatter the
// fraction, which is the direction this whole issue is about.
const TEST_RE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?tsx?$|^src\/test-setup\.ts$/
// Generated or mock code, excluded and SAID to be excluded rather than
// silently folded into either bucket. `bindings.ts` is specta output (mutating
// it would test the generator), and `tauri-mock/` is test scaffolding that
// only ever runs under vitest/Playwright.
const EXCLUDED_RE = /^src\/lib\/bindings\.ts$|^src\/lib\/tauri-mock\//

/** @typedef {{path: string, lines: number|null}} ChangedFile */

/**
 * Normalise a `--changed`/`--changed-from` entry. Accepts a bare path
 * (`git diff --name-only`) or a numstat triple (`git diff --numstat`:
 * `<added>\t<deleted>\t<path>`, where a binary file reports `-`).
 *
 * @param {string} raw
 * @returns {ChangedFile | null}
 */
export function parseChangedEntry(raw) {
  const line = raw.replace(/\r$/, '')
  if (line.trim().length === 0) return null
  const numstat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
  if (!numstat) return { path: line.trim(), lines: null }
  // Renames print either `old/path => new/path` or the compacted
  // `src/lib/{old.ts => new.ts}`, where the braces mark the differing SEGMENT
  // and the surrounding directories are shared. Taking everything after the
  // last ` => ` is right for the first form and drops the shared prefix on the
  // second, which is how a renamed enrolled module would stop being selected.
  const raw3 = numstat[3].trim()
  const BRACED = /\{[^{}]*? => ([^{}]*?)\}/g
  const dest = BRACED.test(raw3)
    ? raw3.replaceAll(BRACED, '$1').replaceAll('//', '/')
    : raw3.includes(' => ')
      ? raw3.slice(raw3.lastIndexOf(' => ') + 4)
      : raw3
  const added = numstat[1] === '-' ? 0 : Number(numstat[1])
  const deleted = numstat[2] === '-' ? 0 : Number(numstat[2])
  return { path: dest.replace(/\/$/, ''), lines: added + deleted }
}

/**
 * How much of the diff the mutation run actually reached.
 *
 * `mutated` counts only the source files of the modules that will really run
 * (`selected`), never the ones the `--max` cap skipped — a module that was not
 * mutated here cannot be credited with covering its own file.
 *
 * @param {{changedFiles: (string|ChangedFile)[], selected: string[], modules?: object}} opts
 */
export function diffCoverage({ changedFiles, selected, modules = MODULES }) {
  const entries = changedFiles
    .map((f) => (typeof f === 'string' ? parseChangedEntry(f) : f))
    .filter((f) => f !== null)
  const mutatedPaths = new Set(selected.map((name) => modules[name]?.src).filter(Boolean))

  const mutated = []
  const unmutated = []
  const excluded = []
  for (const entry of entries) {
    if (!SOURCE_RE.test(entry.path) || TEST_RE.test(entry.path)) continue
    if (EXCLUDED_RE.test(entry.path)) excluded.push(entry)
    else if (mutatedPaths.has(entry.path)) mutated.push(entry)
    else unmutated.push(entry)
  }

  // `null` when the caller passed bare paths: reporting a line fraction we do
  // not have would be the same defect one level down.
  const sum = (rows) =>
    rows.some((r) => r.lines === null) ? null : rows.reduce((a, r) => a + r.lines, 0)
  const sourceRows = [...mutated, ...unmutated]
  return {
    mutatedFiles: mutated.map((r) => r.path).toSorted(),
    unmutatedFiles: unmutated.map((r) => r.path).toSorted(),
    excludedFiles: excluded.map((r) => r.path).toSorted(),
    sourceFiles: sourceRows.length,
    mutatedLines: sum(mutated),
    unmutatedLines: sum(unmutated),
    sourceLines: sum(sourceRows),
  }
}

// How many unmutated paths the comment names before it truncates. Long enough
// that a normal PR lists all of them, short enough that a repo-wide rename
// does not bury the table under a hundred lines.
const MAX_NAMED_PATHS = 12

/**
 * The scope sentence (#3691): what fraction of this diff's source the run
 * reached, and what it did not.
 */
function renderCoverage(coverage, mutatedAnything) {
  if (coverage === undefined || (coverage.sourceFiles === 0 && coverage.excludedFiles.length === 0))
    return []
  const { sourceFiles, unmutatedFiles, mutatedLines, unmutatedLines, sourceLines } = coverage
  // Named, not silently dropped. On #3685 the excluded bucket was 53 lines of
  // tauri-mock — leaving it out of both numerator and denominator without
  // saying so would be the same defect at a smaller scale.
  const excludedClause =
    coverage.excludedFiles.length === 0
      ? []
      : [
          '',
          `Outside the fraction (generated or mock sources, never mutated): ${namedPaths(coverage.excludedFiles)}`,
        ]
  if (sourceFiles === 0) {
    return ['', `This diff changed no mutable source file.`, ...excludedClause]
  }
  const mutatedFiles = sourceFiles - unmutatedFiles.length
  const known = sourceLines !== null && sourceLines > 0
  const lineClause = known ? ` (${mutatedLines} of ${sourceLines} changed line(s))` : ''

  if (mutatedFiles === 0) {
    // The vacuous-100% case's honest sibling: say it in a sentence rather
    // than posting nothing, which reads as "nothing to report".
    const totalClause = known ? ` (${sourceLines} changed line(s))` : ''
    const head = mutatedAnything
      ? `**Diff coverage: none of this diff's ${sourceFiles} changed source file(s)${totalClause} was mutated.**`
      : `**No enrolled module was touched; this diff drew no mutation signal.** ${sourceFiles} changed source file(s)${totalClause} went unmutated.`
    return ['', head, '', namedPaths(unmutatedFiles), ...excludedClause]
  }
  const lines = [
    '',
    `Diff coverage: **${mutatedFiles} of ${sourceFiles}** changed source file(s)${lineClause} were mutated.`,
  ]
  if (unmutatedFiles.length > 0) {
    lines.push(
      '',
      `The other ${unmutatedFiles.length} belong${unmutatedFiles.length === 1 ? 's' : ''} to no enrolled module and drew **no mutation signal**${
        unmutatedLines === null ? '' : ` (${unmutatedLines} changed line(s))`
      }:`,
      namedPaths(unmutatedFiles),
    )
  }
  return [...lines, ...excludedClause]
}

function namedPaths(paths) {
  const shown = paths.slice(0, MAX_NAMED_PATHS)
  const rest = paths.length - shown.length
  return `\`${shown.join('`, `')}\`${rest > 0 ? ` and ${rest} more` : ''}`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Renders a selection as the Markdown paragraph the PR comment opens with.
 * Exported so the wording is testable; the workflow shells out for it rather
 * than embedding JS in a `run:` block.
 */
export function renderSelection({ selected, skipped, reason, coverage }) {
  const parts = [`Selection: ${reason}`]
  if (selected.length > 0) parts.push('', `Mutated: \`${selected.join('`, `')}\``)
  if (skipped.length > 0)
    parts.push('', `Skipped here (the weekly sweep covers them): \`${skipped.join('`, `')}\``)
  parts.push(...renderCoverage(coverage, selected.length > 0))
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

  // `--markdown` is a pure RENDERING mode and writes no step outputs (#3728).
  // `mutation-pr.yml`'s "Render report" step re-invokes this script to draw the
  // report paragraph, from a step with no `id:` — so the second run appended a
  // duplicate `modules=`/`count=`/`unmutated=` triple to `$GITHUB_OUTPUT` that
  // nothing could ever read, under a step nothing could reference. Harmless in
  // effect, but it makes the output file a misleading record of what the job
  // decided, and the decision belongs to the `select` step alone.
  const out = args.markdown ? null : process.env.GITHUB_OUTPUT
  if (out) {
    // Space-separated so the workflow can pass it straight to
    // `scripts/run-mutation.mjs`, which takes module names as argv.
    //
    // `unmutated` (#3691) is how the workflow knows a diff that selected
    // NOTHING still has something worth saying: posting no comment on a PR
    // that changed six unenrolled source files reads as "nothing to report"
    // when the truth is "no mutation signal exists for this change".
    appendFileSync(
      out,
      `modules=${result.selected.join(' ')}\ncount=${result.selected.length}\n` +
        `unmutated=${result.coverage.unmutatedFiles.length}\n`,
      'utf8',
    )
  }
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
