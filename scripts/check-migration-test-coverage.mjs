#!/usr/bin/env node
// #4144 — the migration-test nextest filter documented in
// `src-tauri/migrations/AGENTS.md` (§ "Verifying a migration") is PROSE
// ONLY. Grepping the tree for it — or its old, narrower form — finds zero
// references in any CI workflow, `justfile` recipe, or prek hook; the only
// hits are the doc paragraph itself plus two unrelated session-log mentions
// of issue `#606`. Nothing selects "the migration tests" as a group, which
// means the filter's correctness (#4137 widened it from 15 matched tests to
// 27, a verified strict superset) buys a human running it BY HAND, and
// nothing else. A migration test named outside the documented convention —
// `<table>_<NNNN>_<what>_<issue>` — is simply not in that group, runs as an
// ordinary test indistinguishable from any other, and nothing anywhere
// signals that the naming convention broke. Twelve tests already drifted out
// of the filter unnoticed before #4137 caught it by hand; nothing stops the
// thirteenth.
//
// ─── What this checks ───────────────────────────────────────────────────
//
// This makes the convention STRUCTURAL: for every migration file under
// `src-tauri/migrations/`, it requires at least one test function — in the
// exact files AGENTS.md names as carrying migration tests
// (`src-tauri/src/db/tests.rs`, its `spaces` sibling, and `agaric-sync`'s `snapshot/tests.rs`) —
// whose name embeds that migration's zero-padded number the documented way
// (the literal substring `_<NNNN>_`), i.e. a name the documented nextest
// filter's `_0[0-9]{3}_` half would actually select. It does NOT run
// nextest, compile anything, or need `DATABASE_URL`: this is a textual scan
// over migration filenames and Rust test-function names, the same "narrow
// and mechanical" scoping the rest of this repo's prek guards use — see
// `check-pr-overlap-trust-boundary.mjs`'s header for the same argument made
// at length.
//
// ─── Baseline (shrink-only) ────────────────────────────────────────────
//
// 102 of this repo's 111 migrations predate the `_<NNNN>_` naming
// convention entirely — AGENTS.md's own "Older batch, pinned by issue
// number" paragraph documents exactly this: `_376`/`_606`/`_708` tests
// cover an unspecified set of early migrations by ISSUE number, not by
// migration number, because they predate the migration-number convention.
// Retrofitting 102 tests to carry a `_<NNNN>_` tag is a content sweep, not
// a guard's job, so — following the same shrink-only-baseline convention as
// `scripts/doc-code-paths-baseline.json` and
// `src-tauri/table-ownership-baseline.txt` — those migration numbers are
// grandfathered in `src-tauri/migrations-test-coverage-baseline.txt`. #4182
// tracks burning that list down.
//
// A migration number is exempt ONLY if it is already listed in that file.
// Nothing is grandfathered automatically: migration 0112 (or any migration
// added after this guard ships) must have a matching test, or the guard
// fails on it the moment it lands — which is precisely the gap #4144
// reports: today, nothing says so.
//
// "Shrink-only" is TWO failure modes, not one — the same pair
// `check-doc-code-paths.mjs`'s baseline enforces, and enforcing only the
// first is what makes the phrase untrue:
//   - a migration NOT in the baseline with no covering test — a regression;
//   - a STALE entry: a baselined migration that now HAS a covering test (or
//     that no longer exists at all). Left unchecked, grandfathering never
//     expires and the list stops meaning anything; the guard fails until it
//     is pruned with `--update-baseline`.
//
// ─── Where "covered" and "the filter selects it" could still diverge ─────
//
// The whole value of this guard is that its notion of COVERED is the
// filter's, so the two are pinned against each other rather than merely
// described alike:
//
//   - THE CEILING is checked, not assumed. `_0[0-9]{3}_` spans `0000`-`0999`
//     only. A migration numbered `1000` with a perfectly conventional
//     `t_1000_thing_1234` test satisfies the `_<NNNN>_` substring rule while
//     the filter selects nothing — guard green, test never in the group.
//     `FILTER_SELECTABLE_NUMBER_RE` closes that, and #4144's acceptance
//     names this exact case.
//   - A `.sql` FILE THIS GUARD CANNOT NUMBER is a wiring failure, not a
//     silent skip — see `listMigrations`.
//   - SCOPE, deliberately narrower than the filter: the filter selects a
//     `_0[0-9]{3}_` test wherever it lives in the crate, while this guard
//     only counts one in the three files AGENTS.md names. Today
//     `src-tauri/src/db/recovery.rs` holds two such tests (for migrations
//     `0073` and `0099`); the filter runs them, this guard does not count
//     them, and both numbers sit in the baseline as a result. That direction
//     is the safe one — the guard is stricter than the filter, never looser
//     — but it is a real divergence and it is why those two baseline entries
//     are not quite "no test exists". #4182 tracks the sweep.
//
// Falsification: rename an existing, non-grandfathered migration's covering
// test to drop its `_<NNNN>_` tag, and this guard goes red on that
// migration number.
//
// Usage:
//   node scripts/check-migration-test-coverage.mjs
//   node scripts/check-migration-test-coverage.mjs --update-baseline
//
// Exit: 0 clean / 1 an uncovered, non-grandfathered migration, or a
// migration number past the documented filter's ceiling / 2 invocation or
// wiring error (no migrations found, or a `.sql` file this guard cannot
// number — the guard could not answer, not an answer of "clean").

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'src-tauri', 'migrations')
const BASELINE_FILE = join(REPO_ROOT, 'src-tauri', 'migrations-test-coverage-baseline.txt')

// The exact files AGENTS.md names as carrying migration tests: "These live
// in db::tests (src-tauri/src/db/tests.rs) — and a few siblings under
// snapshot/spaces." Scoped to these three, not every `*.rs` file in the
// tree, for the same reason `check-android-trigger.mjs` and
// `check-pr-overlap-trust-boundary.mjs` scope to the ONE file each is
// about: this is insurance for the specific convention AGENTS.md documents,
// not a general "does some test somewhere mention this migration" search. A
// test with the right name sitting in a file OTHER than these three does
// not satisfy the documented convention (nor would it be selected by
// running the filter against `db::tests` the way AGENTS.md's own recipe
// does) and must not count.
const TEST_FILES = [
  join(REPO_ROOT, 'src-tauri', 'src', 'db', 'tests.rs'),
  join(REPO_ROOT, 'src-tauri', 'agaric-sync', 'src', 'snapshot', 'tests.rs'),
  join(REPO_ROOT, 'src-tauri', 'src', 'spaces', 'tests.rs'),
]

// Migration filename convention: `NNNN_description.sql` — see
// `migrations/AGENTS.md`'s "New migration" rule.
const MIGRATION_FILE_RE = /^(\d{4})_.*\.sql$/

// The documented filter's OWN ceiling, as data rather than as prose.
// AGENTS.md: "Ceiling: migration numbers below `1000`" — `_0[0-9]{3}_` spans
// `0000`-`0999` and nothing else, because the leading literal `0` is what
// lets the filter avoid matching unrelated 4-digit numbers (issue/PR
// references, years, sizes) elsewhere in a test name.
//
// THIS GUARD MUST MIRROR THAT, NOT ASSUME IT. An earlier draft argued no
// separate ceiling check was needed because "a migration numbered `10000`
// would not match the 4-digit group" — which is true and beside the point:
// the ceiling is `0999`, not `9999`. Migration `1000` matches
// `MIGRATION_FILE_RE` perfectly, and a test named `t_1000_thing_1234` satisfies
// `testCoversMigration`'s `_<NNNN>_` substring test — so the guard went GREEN
// on a migration whose test the documented filter would NEVER select. That is
// precisely the divergence #4144 exists to close ("a migration can satisfy the
// guard and still never run"), and #4144's acceptance names this exact case:
// "migration `1000` would immediately have no matching test and redden".
//
// It is deliberately NOT baseline-exemptible. Grandfathering a ceiling breach
// would hide a filter that has stopped selecting migration tests at all,
// which is a broken filter, not a missing test — the fix is to widen the
// filter in AGENTS.md (and this constant with it), not to record the
// migration as an exception.
const FILTER_SELECTABLE_NUMBER_RE = /^0[0-9]{3}$/

/**
 * Every migration number (as a zero-padded 4-digit STRING, matching how it
 * appears inside a test name) present under `dir`, plus every `.sql` file
 * there whose name does NOT follow the convention.
 *
 * MALFORMED NAMES ARE RETURNED, NOT DROPPED. A `.sql` file that does not
 * match `MIGRATION_FILE_RE` — `10000_x.sql` (five digits), `foo.sql`, `12_x.sql`
 * — is a migration this guard cannot number, and therefore one whose test
 * coverage it cannot judge. Silently skipping it makes the guard report
 * "clean" about a file it never looked at, which is the fail-open shape every
 * other guard in this repo refuses (see `check-doc-code-paths.mjs`'s
 * `scanErrors`). The caller turns this into a wiring failure.
 *
 * @param {string} dir
 * @returns {{ numbers: string[], malformed: string[] }}
 */
export function listMigrations(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) return { numbers: [], malformed: [] }
  const numbers = []
  const malformed = []
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith('.sql')) continue // AGENTS.md and friends are not migrations
    const m = MIGRATION_FILE_RE.exec(name)
    if (m === null) malformed.push(name)
    else numbers.push(m[1])
  }
  return { numbers: numbers.toSorted(), malformed }
}

/**
 * `listMigrations(dir).numbers` — kept as its own export because an
 * importer overwhelmingly wants just the numbers.
 *
 * @param {string} dir
 */
export function listMigrationNumbers(dir = MIGRATIONS_DIR) {
  return listMigrations(dir).numbers
}

/**
 * Every `#[test]` / `#[tokio::test]` function NAME across `files` — the
 * exact shape a Rust test attribute takes in this codebase (the attribute
 * line immediately above an optional `async` and the `fn` line; verified
 * against every migration test in `db/tests.rs` today). Files that don't
 * exist are skipped rather than erroring: a caller may point this at a tree
 * carrying only the files it needs, and `main()`'s own real-repo run always
 * has all three named in `TEST_FILES`.
 *
 * @param {string[]} files
 */
export function extractTestNames(files) {
  const names = []
  // `#[tokio::test]` sometimes carries runtime args — `#[tokio::test(flavor
  // = "multi_thread", worker_threads = 2)]` is a real, common shape in this
  // tree's migration tests (`attachment_blobs_backfill_dedups_pre_0094_…`
  // among them) — so the attribute's own parens are OPTIONAL, not absent.
  // Without `(?:\([^)]*\))?` this guard silently underreported coverage: it
  // is a fail-CLOSED direction for `computeUncovered` (a real test looks
  // uncovered, producing a false positive the author can trivially see is
  // wrong by opening the file) rather than a fail-open one, but a guard that
  // cries wolf on real, already-covered migrations is a guard people learn
  // to route around.
  // `[^\S\r\n]*\r?\n\s*` and NOT `\s*(?:\r?\n\s*)+`: the latter lets `\s*`
  // and the `\r?\n` group both match a newline, so the engine has an
  // exponential number of ways to split a run of blank lines between them
  // and backtracks catastrophically on input like `#[test]` followed by many
  // newlines and no `fn` (CodeQL js/redos, high). Restricting the first
  // stretch to HORIZONTAL whitespace makes the split unambiguous, and the
  // trailing `\s*` still absorbs any number of blank or indented lines.
  const re =
    /#\[(?:tokio::)?test(?:\([^)]*\))?\][^\S\r\n]*\r?\n\s*(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g
  for (const file of files) {
    if (!existsSync(file)) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(re)) names.push(m[1])
  }
  return names
}

/**
 * Whether `migrationNumber` (a zero-padded 4-digit string) is embedded in
 * `testName` the way the documented nextest filter's `_0[0-9]{3}_` half
 * selects it: the literal substring `_<NNNN>_`. Delimited on BOTH sides by
 * `_`, matching the filter's own regex fragment exactly — a test named
 * `..._00011_...` does not accidentally satisfy migration `0001` (the
 * substring `_0001_` never occurs in it: the character after `0001` is
 * another `1`, not `_`).
 *
 * @param {string} testName
 * @param {string} migrationNumber
 */
export function testCoversMigration(testName, migrationNumber) {
  return testName.includes(`_${migrationNumber}_`)
}

/**
 * Every migration number in `migrationNumbers` with NO test in `testNames`
 * covering it, per `testCoversMigration`.
 *
 * @param {string[]} migrationNumbers
 * @param {string[]} testNames
 */
export function computeUncovered(migrationNumbers, testNames) {
  return migrationNumbers.filter((n) => !testNames.some((name) => testCoversMigration(name, n)))
}

/**
 * The shrink-only baseline: grandfathered migration numbers, one per
 * non-comment, non-blank line. Missing file reads as an empty baseline —
 * the same "absent baseline is not an invocation error" discipline
 * `check-doc-code-paths.mjs` uses.
 *
 * @param {string} path
 */
export function readBaseline(path = BASELINE_FILE) {
  if (!existsSync(path)) return new Set()
  const out = new Set()
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    out.add(line)
  }
  return out
}

/**
 * @param {string[]} numbers
 * @param {string} path
 */
function writeBaseline(numbers, path = BASELINE_FILE) {
  const header = [
    '# Shrink-only baseline for scripts/check-migration-test-coverage.mjs (#4144).',
    '#',
    '# Migration numbers listed here predate the `_<NNNN>_` per-migration test',
    '# naming convention documented in src-tauri/migrations/AGENTS.md and have no',
    '# dedicated test for this guard to find. A migration number NOT listed here',
    '# must have a test whose name embeds it (the literal `_<NNNN>_`) or the',
    '# guard fails. Regenerate (only to intentionally grandfather a migration that',
    '# genuinely predates the convention) with:',
    '#   node scripts/check-migration-test-coverage.mjs --update-baseline',
    '',
  ]
  writeFileSync(path, `${header.join('\n')}${numbers.toSorted().join('\n')}\n`)
}

/**
 * The full verdict, parameterised so a caller can point every input at
 * a throwaway fixture tree without touching this repository. `main()` calls
 * this with no arguments, which resolves every input against the real repo.
 *
 * @param {{ migrationsDir?: string, testFiles?: string[], baselinePath?: string }} [opts]
 */
export function runCheck({
  migrationsDir = MIGRATIONS_DIR,
  testFiles = TEST_FILES,
  baselinePath = BASELINE_FILE,
} = {}) {
  const { numbers: migrations, malformed } = listMigrations(migrationsDir)
  if (migrations.length === 0) {
    return {
      exitCode: 2,
      lines: [
        `ERROR: no migrations found under ${migrationsDir} — check-migration-test-coverage cannot answer`,
      ],
    }
  }
  // A `.sql` file this guard cannot number is a file it cannot judge — a
  // WIRING failure, not a violation and emphatically not a pass. See
  // `listMigrations`.
  if (malformed.length > 0) {
    return {
      exitCode: 2,
      lines: [
        `ERROR: ${malformed.length} file(s) under ${migrationsDir} end in .sql but do not follow`,
        '`NNNN_description.sql`, so this guard cannot number them and cannot judge their test',
        'coverage — it must not report "clean" about a file it never looked at:',
        ...malformed.map((name) => `  - ${name}`),
      ],
    }
  }
  const testNames = extractTestNames(testFiles)
  const uncovered = computeUncovered(migrations, testNames)
  const baseline = readBaseline(baselinePath)
  const newUncovered = uncovered.filter((n) => !baseline.has(n))
  // The documented filter's ceiling, checked rather than assumed — see
  // `FILTER_SELECTABLE_NUMBER_RE`. Not baseline-exemptible on purpose.
  const beyondCeiling = migrations.filter((n) => !FILTER_SELECTABLE_NUMBER_RE.test(n))
  // STALE BASELINE ENTRIES — the second half of "shrink-only", without which
  // the phrase is not true. This guard's header, and the prek hook's comment,
  // both claim the baseline can only ever shrink; a first cut enforced only
  // the growth direction (a NEW uncovered migration reds), so a migration
  // that later GAINED a correctly-named test kept its grandfathering
  // silently, forever — and a baseline line naming a migration that does not
  // exist at all (a deleted migration, a typo) was accepted just as quietly.
  // Both are the phantom-cover failure `check-doc-code-paths.mjs`'s baseline
  // spells out as one of its TWO failure modes, and this one had only one.
  //
  // A beyond-ceiling migration counts as uncovered here even when a
  // `_<NNNN>_` test exists for it, because no such test is SELECTABLE — so
  // its baseline entry is not stale, it is simply not the thing keeping the
  // guard red.
  const notCovered = new Set([...uncovered, ...beyondCeiling])
  const staleBaseline = [...baseline].filter((n) => !notCovered.has(n)).toSorted()

  if (newUncovered.length === 0 && beyondCeiling.length === 0 && staleBaseline.length === 0) {
    return {
      exitCode: 0,
      lines: [
        `OK: every non-grandfathered migration has a matching test ` +
          `(${migrations.length} migrations, ${baseline.size} grandfathered)`,
      ],
    }
  }
  const lines = []
  if (newUncovered.length > 0) {
    lines.push('ERROR: migration(s) with no test the documented nextest filter would select:')
    for (const n of newUncovered) {
      lines.push(
        `  - ${n} — no test in db/tests.rs (or its snapshot/spaces siblings) has a name containing \`_${n}_\``,
      )
    }
    lines.push(
      '',
      `Either add a test named \`<table>_${newUncovered[0]}_<what>_<issue>\` (see migrations/AGENTS.md's`,
      '"Verifying a migration" section), or, if this migration genuinely predates the naming',
      'convention, grandfather it with:',
      '  node scripts/check-migration-test-coverage.mjs --update-baseline',
    )
  }
  if (beyondCeiling.length > 0) {
    lines.push(
      `ERROR: migration number(s) past the documented nextest filter's ceiling (\`_0[0-9]{3}_\``,
      'spans 0000-0999 only — see migrations/AGENTS.md\'s "Ceiling" bullet):',
      ...beyondCeiling.map(
        (n) => `  - ${n} — no test name can be selected by the filter as written`,
      ),
      '',
      'A correctly-named `_<NNNN>_` test for these migrations satisfies the naming convention and',
      'is STILL never selected as part of the migration-test group, which is the exact silence',
      '#4144 exists to break. Widen the filter in migrations/AGENTS.md and',
      '`FILTER_SELECTABLE_NUMBER_RE` in this script together. Grandfathering does not apply: this',
      'is a broken filter, not a missing test.',
    )
  }
  if (staleBaseline.length > 0) {
    lines.push(
      'ERROR: the baseline has stale entr(ies) — migration(s) grandfathered as having no covering',
      'test that DO have one now (or that no longer exist at all):',
      ...staleBaseline.map((n) => `  - ${n}`),
      '',
      'Prune them, so the baseline keeps no phantom cover for a migration that already moved on:',
      '  node scripts/check-migration-test-coverage.mjs --update-baseline',
    )
  }
  return { exitCode: 1, lines }
}

function updateBaseline() {
  const migrations = listMigrationNumbers()
  const testNames = extractTestNames(TEST_FILES)
  const uncovered = computeUncovered(migrations, testNames)
  writeBaseline(uncovered)
  console.log(`OK: wrote ${uncovered.length} grandfathered migration number(s) to ${BASELINE_FILE}`)
  return 0
}

function main() {
  const { exitCode, lines } = runCheck()
  for (const line of lines) (exitCode === 0 ? console.log : console.error)(line)
  return exitCode
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.includes('--update-baseline')) process.exit(updateBaseline())
  else process.exit(main())
}
