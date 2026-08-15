#!/usr/bin/env node
// #3737 — `.github/zizmor.yml` used to suppress zizmor's `cache-poisoning`
// finding on four steps (two `Swatinem/rust-cache`, two `actions/setup-node`,
// all in ci.yml's build-only jobs) by LINE NUMBER: `ci.yml:318`, etc. A line
// number is not a key for "this step" — it is a key for "whatever text is on
// this line today". Four times in one day, an unrelated comment added
// anywhere above those anchors in ci.yml shifted every line below it, so a
// diff that touched no cache step turned four suppressed findings into four
// `high` failures (loud direction) — and, un-noticed until it happens, could
// just as easily re-attach an anchor to a *different* step and silently
// suppress a real new finding (quiet direction). Full history: the file
// header of `.github/zizmor.yml`.
//
// The fix is to stop anchoring by position. zizmor has its own suppression
// mechanism for exactly this: a `# zizmor: ignore[rule-id]` comment placed
// anywhere inside the finding's step (see `IGNORE_EXPR` in zizmor's
// `finding/location.rs`). That anchors to the step's CONTENT — the comment
// travels with the step through any number of unrelated edits elsewhere in
// the file — so `.github/zizmor.yml` no longer carries a `cache-poisoning`
// `ignore:` list at all; the four suppressions live as inline comments on
// the four steps themselves.
//
// This guard protects that invariant two ways:
//   1. `.github/zizmor.yml` must never regain a line-anchored
//      `cache-poisoning` `ignore:` list — that would be reintroducing the
//      exact fragility #3737 removed.
//   2. At least one inline `# zizmor: ignore[cache-poisoning]` comment must
//      exist somewhere under `.github/workflows/**` — finding zero is a
//      WIRING failure (this guard, or the suppression mechanism itself, has
//      fallen out of step with the repo), not a vacuous pass. Same shape as
//      `check-zizmor-version-pin.mjs`'s "zero tool: sites found" guard.
//
// Deliberately NOT re-implementing zizmor's own cache-poisoning heuristics
// (which steps actually trigger the audit, under which `on:` triggers) in
// JS: that would be a second copy of logic zizmor already owns, and a
// second copy is exactly the kind of thing these guards exist to catch
// drifting apart, not to create (see `scripts/check-mutants-scope.mjs`'s
// note on why this family of script avoids importing a YAML library and
// stays line-based — the same reasoning applies one level up to avoiding a
// second audit engine). The end-to-end self-test below asks the real
// `zizmor` binary the question that matters — "is this still suppressed
// after an unrelated edit moves every line below it?" — instead of asking a
// re-implementation of zizmor's opinion about it.
//
// Usage:
//   node scripts/check-cache-poisoning-suppressions.mjs
//   node scripts/check-cache-poisoning-suppressions.mjs --self-test
//
// Exit codes: 0 = healthy; 1 = a real problem (or the wiring guard above);
//             2 = self-test failure.

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows')
const ZIZMOR_CONFIG_PATH = join(REPO_ROOT, '.github', 'zizmor.yml')
const CI_YML_PATH = join(WORKFLOWS_DIR, 'ci.yml')
const PREK_CONFIG_PATH = join(REPO_ROOT, 'prek.toml')

/**
 * How many inline `# zizmor: ignore[cache-poisoning]` suppressions the repo
 * is expected to carry — the four #3737 introduced (two `Swatinem/rust-cache`,
 * two `actions/setup-node`, all in ci.yml's build-only jobs).
 *
 * EXACT on purpose, and the strictness is the point: `checkHygiene` only
 * notices zero, so without an exact count a suppression appearing in some
 * other workflow — a decision nobody reviewed as a cache-poisoning decision —
 * lands silently. Adding a fifth is a legitimate thing to do; it just has to
 * be a deliberate edit here, which is why the failure detail says so instead
 * of reading like a defect report.
 */
export const EXPECTED_INLINE_SUPPRESSIONS = 4

/**
 * This guard's `--self-test` is the only thing that re-runs zizmor when
 * `.github/zizmor.yml` itself changes. The `zizmor` prek hook cannot cover
 * that file: it forwards its matched filenames to the binary as AUDIT
 * TARGETS, so widening its `files` pattern to the config would ask zizmor to
 * audit its own config as if it were a workflow. The dependency is therefore
 * recorded here rather than widened there — and recorded as an assertion,
 * because a `files` pattern that quietly stopped naming one of these paths
 * would take that coverage with it and nothing would say so. `prek.toml` is
 * in the list too: this guard now reads it, so an edit to it must re-run.
 */
export const SELF_TEST_HOOK_ID = 'cache-poisoning-suppressions-self-test'
export const SELF_TEST_HOOK_DEPENDENCIES = Object.freeze([
  'scripts/check-cache-poisoning-suppressions.mjs',
  '.github/zizmor.yml',
  '.github/workflows/ci.yml',
  'prek.toml',
])

/**
 * A prek hook's `files` pattern, as a live RegExp, read out of `prek.toml`.
 * Throws when the hook or its pattern is absent — a rename must fail loud
 * rather than let the coverage assertion pass vacuously.
 */
export function findHookFilesPattern(prekTomlText, hookId) {
  const idIdx = prekTomlText.indexOf(`id = "${hookId}"`)
  if (idIdx === -1) throw new Error(`no prek hook \`${hookId}\` found in prek.toml`)
  const rest = prekTomlText.slice(idIdx)
  const endIdx = rest.indexOf('\n[[')
  const block = endIdx === -1 ? rest : rest.slice(0, endIdx)
  const m = block.match(/^files = (['"])(.*)\1\s*$/m)
  if (!m) throw new Error(`prek hook \`${hookId}\` has no \`files\` pattern`)
  // TOML basic strings ("…") escape each backslash; literal strings ('…') do
  // not. Getting this wrong turns `\\.` into a wildcard and the assertion
  // into a weaker one that still passes.
  return new RegExp(m[1] === "'" ? m[2] : m[2].replace(/\\\\/g, '\\'))
}

// ---------------------------------------------------------------------------
// (1) The regression this guard exists to catch: a line-anchored
//     `cache-poisoning` ignore list reappearing in the baseline file.
// ---------------------------------------------------------------------------

/**
 * Scans `.github/zizmor.yml`'s text for a `rules: / cache-poisoning: /
 * ignore:` block and returns every `filename.yml:NNN`-shaped entry found
 * inside it — the exact shape #3737 removed. An empty array means healthy
 * (no rule block, or a rule block with no `ignore:` list, or an `ignore:`
 * list that names something other than a bare workflow-line anchor).
 *
 * Line-based on purpose (see file header): this only needs to recognise the
 * one shape it must forbid, not parse arbitrary zizmor config YAML.
 *
 * The key is matched at ANY indent, and with optional quotes. It used to
 * require exactly two spaces, which made the guard fail OPEN on its own
 * subject matter: reformatting `.github/zizmor.yml` to four-space indent —
 * something a YAML formatter does without anyone reading the diff — put the
 * forbidden shape back while `checkHygiene` reported healthy, because
 * `ruleLineIdx === -1` returns `[]` and `[]` means "no problem". Over-
 * matching (a `cache-poisoning:` key nested somewhere unexpected) can only
 * make this guard louder, and loud is the direction it must err in.
 *
 * EVERY occurrence of the key is scanned, not just the first. `findIndex`
 * stopped at occurrence one, so a second `cache-poisoning:` block — a
 * duplicate key, a per-`rules:` section, a merged config — carried its
 * anchors past the guard, and `[]` is again how this module spells
 * "healthy". That is the same fail-open SHAPE as the four-space-indent bug
 * above, one axis over; a loop is the whole cost of closing it.
 */
const CACHE_POISONING_KEY_RE = /^\s*['"]?cache-poisoning['"]?:\s*$/

export function findLineAnchoredCachePoisoningIgnores(zizmorYmlText) {
  const lines = zizmorYmlText.split('\n')
  const anchors = []
  for (const [ruleLineIdx, ruleLine] of lines.entries()) {
    if (!CACHE_POISONING_KEY_RE.test(ruleLine)) continue
    const ruleIndent = ruleLine.match(/^(\s*)/)[1].length
    for (let i = ruleLineIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') continue
      const indent = line.match(/^(\s*)/)[1].length
      // Dedented back to (or past) the `cache-poisoning:` key's own indent —
      // its block has ended.
      if (indent <= ruleIndent) break
      const m = line.match(/^\s*-\s*([^\s#]+\.ya?ml:\d+(?::\d+)?)\s*(?:#.*)?$/)
      if (m) anchors.push(m[1])
    }
  }
  return anchors
}

// ---------------------------------------------------------------------------
// (2) Inventory of the inline suppressions that replaced the anchor list.
// ---------------------------------------------------------------------------

const INLINE_IGNORE_RE = /#\s*zizmor:\s*ignore\[([^\]]*)\]/

/**
 * True when a line carries an inline zizmor suppression that names
 * `cache-poisoning` — including as one entry of a comma-separated list.
 *
 * Shared by the inventory scan and by the negative control's "strip today's
 * suppressions" step, which must strip THESE and only these: stripping every
 * inline ignore regardless of rule id was correct only for as long as every
 * inline ignore in ci.yml happened to be a cache-poisoning one. The first
 * suppression for some other rule would have been deleted along with them
 * and its finding attributed to the control's line-anchor list.
 */
export function ignoresCachePoisoning(line) {
  const m = line.match(INLINE_IGNORE_RE)
  if (!m) return false
  return m[1]
    .split(',')
    .map((r) => r.trim())
    .includes('cache-poisoning')
}

/** Every `.yml`/`.yaml` under `dir`, recursively, as paths relative to `dir`. */
function workflowFilesUnder(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...workflowFilesUnder(join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      out.push(rel)
    }
  }
  return out
}

/**
 * Every `# zizmor: ignore[...]` comment naming `cache-poisoning` found
 * across `.github/workflows/**`, as `{ location }` (`file:line`). Scans ALL
 * workflow files, not a hardcoded filename list, for the same reason
 * `check-zizmor-version-pin.mjs`'s `findZizmorToolPins` does: a suppression
 * moved or added to a different workflow is covered automatically.
 *
 * Recursive, so the `**` in that description is the truth and not a rounding
 * of it: `.github/zizmor.yml` and this script's header both describe the
 * coverage that way, and a flat `readdirSync` would have quietly stopped
 * counting a suppression parked one directory down.
 */
export function findInlineCachePoisoningSuppressions(dir = WORKFLOWS_DIR) {
  if (!existsSync(dir)) throw new Error(`no workflow directory at ${dir}`)
  const hits = []
  for (const name of workflowFilesUnder(dir)) {
    const text = readFileSync(join(dir, name), 'utf8')
    text.split('\n').forEach((line, idx) => {
      if (ignoresCachePoisoning(line)) hits.push({ location: `${name}:${idx + 1}` })
    })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/** Returns an array of human-readable problem strings — empty means healthy. */
export function checkHygiene({ lineAnchors, inlineHits }) {
  const problems = []
  if (lineAnchors.length > 0) {
    problems.push(
      `.github/zizmor.yml has a line-anchored \`cache-poisoning\` ignore list again ` +
        `(${lineAnchors.join(', ')}) — this is the exact fragility #3737 removed. Suppress ` +
        `the finding with an inline \`# zizmor: ignore[cache-poisoning]\` comment on the step ` +
        `itself instead, and delete the anchor.`,
    )
  }
  if (inlineHits.length === 0) {
    problems.push(
      'no `# zizmor: ignore[cache-poisoning]` comment found anywhere in .github/workflows/** — ' +
        'either the suppression mechanism this guard checks has moved (update this script), ' +
        'or every cache-poisoning finding was fixed outright and the suppressions were rightly ' +
        'deleted (delete this guard too), or a suppression was deleted by accident (restore it)',
    )
  }
  return problems
}

/** Throws with every problem spelled out, or returns silently. */
export function assertCachePoisoningSuppressionHygiene({
  zizmorConfigPath = ZIZMOR_CONFIG_PATH,
  workflowsDir = WORKFLOWS_DIR,
} = {}) {
  const lineAnchors = findLineAnchoredCachePoisoningIgnores(readFileSync(zizmorConfigPath, 'utf8'))
  const inlineHits = findInlineCachePoisoningSuppressions(workflowsDir)
  const problems = checkHygiene({ lineAnchors, inlineHits })
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-cache-poisoning-suppressions.mjs found a problem (#3737):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return { lineAnchors, inlineHits }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { inlineHits } = assertCachePoisoningSuppressionHygiene()
  console.log(
    `OK  cache-poisoning suppressions: no line-anchored ignore list, ${inlineHits.length} inline suppression(s) found (${inlineHits.map((h) => h.location).join(', ')})`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function selfTestLineAnchorDetection({ check }) {
  check(
    findLineAnchoredCachePoisoningIgnores('rules: {}\n').length === 0,
    'no cache-poisoning rule block at all → healthy',
    '',
  )
  check(
    findLineAnchoredCachePoisoningIgnores(
      ['rules:', '  cache-poisoning:', '    # a comment, no ignore: list', ''].join('\n'),
    ).length === 0,
    'a cache-poisoning rule block with no ignore: list → healthy',
    '',
  )
  {
    const found = findLineAnchoredCachePoisoningIgnores(
      [
        'rules:',
        '  cache-poisoning:',
        '    ignore:',
        '      - ci.yml:318',
        '      - ci.yml:341',
        '  unpinned-uses: {}',
        '',
      ].join('\n'),
    )
    check(
      found.length === 2 && found[0] === 'ci.yml:318' && found[1] === 'ci.yml:341',
      'a line-anchored cache-poisoning ignore list is found and each entry extracted',
      JSON.stringify(found),
    )
  }
  {
    // A rule block for a DIFFERENT audit must not be mistaken for
    // cache-poisoning's.
    const found = findLineAnchoredCachePoisoningIgnores(
      ['rules:', '  unpinned-uses:', '    ignore:', '      - ci.yml:12', ''].join('\n'),
    )
    check(
      found.length === 0,
      'a line-anchored ignore list under a DIFFERENT rule is not mistaken for cache-poisoning',
      JSON.stringify(found),
    )
  }
  {
    // #3960 — the guard's own fail-open. The forbidden shape reformatted to
    // FOUR-space indent is the same forbidden shape; the old `^\s{2}` key
    // regex returned `[]` for it, and `[]` is how this module spells
    // "healthy". A YAML reformat would have re-armed #3737 silently.
    const fourSpace = [
      'rules:',
      '    cache-poisoning:',
      '        ignore:',
      '            - ci.yml:323',
      '            - ci.yml:349',
      '',
    ].join('\n')
    const found = findLineAnchoredCachePoisoningIgnores(fourSpace)
    check(
      found.length === 2 && found[0] === 'ci.yml:323',
      'a FOUR-space-indented cache-poisoning ignore list is caught too (indent is not part of the shape)',
      JSON.stringify(found),
    )
    check(
      checkHygiene({ lineAnchors: found, inlineHits: [{ location: 'ci.yml:1' }] }).length === 1,
      'and it reaches checkHygiene as a problem rather than reading healthy',
      '',
    )
    // Quoted keys are legal YAML for the same mapping.
    check(
      findLineAnchoredCachePoisoningIgnores(
        ['rules:', "  'cache-poisoning':", '    ignore:', '      - ci.yml:1', ''].join('\n'),
      ).length === 1,
      'a quoted `cache-poisoning:` key is caught too',
      '',
    )
    // …and the discrimination still holds at other indents: a DIFFERENT
    // rule's block must not be read as cache-poisoning's just because the
    // key regex got more tolerant.
    check(
      findLineAnchoredCachePoisoningIgnores(
        ['rules:', '    unpinned-uses:', '        ignore:', '            - ci.yml:12', ''].join(
          '\n',
        ),
      ).length === 0,
      'a four-space-indented ignore list under a DIFFERENT rule is still not mistaken for cache-poisoning',
      '',
    )
  }
  {
    // #3960 (review note 3) — the guard's OTHER fail-open, same shape as the
    // four-space one above: `lines.findIndex` stopped at the first
    // `cache-poisoning:` key, so anchors under a second occurrence were never
    // looked at and `[]` came back meaning "healthy".
    const twoBlocks = [
      'rules:',
      '  cache-poisoning:',
      '    # the first block is clean, which is exactly why the second hid',
      '  unpinned-uses: {}',
      'rules:',
      '  cache-poisoning:',
      '    ignore:',
      '      - ci.yml:401',
      '      - release.yml:22',
      '',
    ].join('\n')
    const found = findLineAnchoredCachePoisoningIgnores(twoBlocks)
    check(
      found.length === 2 && found[0] === 'ci.yml:401' && found[1] === 'release.yml:22',
      'anchors under a SECOND `cache-poisoning:` key are found too (the scan does not stop at the first)',
      JSON.stringify(found),
    )
    check(
      checkHygiene({ lineAnchors: found, inlineHits: [{ location: 'ci.yml:1' }] }).length === 1,
      'and they reach checkHygiene as a problem rather than reading healthy',
      '',
    )
    // The first block's own anchors are still found when BOTH carry some —
    // scanning every occurrence must not mean scanning only the last.
    const bothBlocks = findLineAnchoredCachePoisoningIgnores(
      [
        'rules:',
        '  cache-poisoning:',
        '    ignore:',
        '      - ci.yml:1',
        'rules:',
        '  cache-poisoning:',
        '    ignore:',
        '      - ci.yml:2',
        '',
      ].join('\n'),
    )
    check(
      bothBlocks.join(',') === 'ci.yml:1,ci.yml:2',
      'every `cache-poisoning:` block contributes its anchors, in file order',
      JSON.stringify(bothBlocks),
    )
  }
  {
    // The real repo's current file, right now, must be clean.
    const found = findLineAnchoredCachePoisoningIgnores(readFileSync(ZIZMOR_CONFIG_PATH, 'utf8'))
    check(
      found.length === 0,
      'the real .github/zizmor.yml has no line-anchored cache-poisoning ignore list',
      JSON.stringify(found),
    )
  }
}

function selfTestInlineScan({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'cache-poisoning-scan-'))
  writeFileSync(
    join(dir, 'x.yml'),
    [
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Rust cache',
      '        # zizmor: ignore[cache-poisoning] — build-only job',
      '        uses: Swatinem/rust-cache@abc',
      '      - name: Something else',
      '        # zizmor: ignore[unrelated-rule]',
      '        uses: foo/bar@abc',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(dir, 'not-a-workflow.txt'), '# zizmor: ignore[cache-poisoning]\n', 'utf8')

  const hits = findInlineCachePoisoningSuppressions(dir)
  check(
    hits.length === 1,
    'the scan finds exactly the cache-poisoning inline suppression, ignoring an unrelated rule and non-workflow files',
    JSON.stringify(hits),
  )
  check(
    hits[0]?.location === 'x.yml:5',
    'the hit records the correct file:line',
    JSON.stringify(hits),
  )

  // A comma-separated ignore list naming cache-poisoning alongside another
  // rule must still be found.
  const dir2 = mkdtempSync(join(tmpdir(), 'cache-poisoning-scan-multi-'))
  writeFileSync(
    join(dir2, 'y.yml'),
    ['# zizmor: ignore[cache-poisoning,unpinned-uses] — see .github/zizmor.yml', ''].join('\n'),
    'utf8',
  )
  const hits2 = findInlineCachePoisoningSuppressions(dir2)
  check(
    hits2.length === 1 && hits2[0].location === 'y.yml:1',
    'cache-poisoning is found even when comma-listed alongside another rule',
    JSON.stringify(hits2),
  )

  // #3960 — the scan is recursive, as `.github/workflows/**` (this script's
  // header, and `.github/zizmor.yml`'s) has always claimed. A flat
  // `readdirSync` reported zero for a suppression one directory down, which
  // in `checkHygiene` is the WIRING failure — the loudest possible wrong
  // answer, but a wrong one, and it would have been blamed on the mechanism
  // rather than on the scan.
  {
    const dir3 = mkdtempSync(join(tmpdir(), 'cache-poisoning-scan-nested-'))
    mkdirSync(join(dir3, 'reusable'))
    writeFileSync(
      join(dir3, 'reusable', 'z.yml'),
      ['jobs:', '  build:', '    # zizmor: ignore[cache-poisoning]', ''].join('\n'),
      'utf8',
    )
    const nestedHits = findInlineCachePoisoningSuppressions(dir3)
    check(
      nestedHits.length === 1 && nestedHits[0].location === 'reusable/z.yml:3',
      'the scan recurses into subdirectories of the workflows dir, as `.github/workflows/**` claims',
      JSON.stringify(nestedHits),
    )
  }

  // The rule-id filter the negative control's strip step now shares.
  check(
    ignoresCachePoisoning('        # zizmor: ignore[cache-poisoning] — build-only') &&
      ignoresCachePoisoning('# zizmor: ignore[unpinned-uses,cache-poisoning]') &&
      !ignoresCachePoisoning('# zizmor: ignore[unpinned-uses]') &&
      !ignoresCachePoisoning('        uses: Swatinem/rust-cache@abc'),
    'ignoresCachePoisoning matches only suppressions that name cache-poisoning',
    '',
  )

  // ...and the real repo, right now, must have the four this fix introduced.
  const realHits = findInlineCachePoisoningSuppressions()
  check(
    realHits.length === EXPECTED_INLINE_SUPPRESSIONS,
    `the real .github/workflows/** has exactly the ${EXPECTED_INLINE_SUPPRESSIONS} inline cache-poisoning suppressions #3737 introduced`,
    `found ${realHits.length}, expected ${EXPECTED_INLINE_SUPPRESSIONS}: ${JSON.stringify(realHits)} — ` +
      `if you ADDED a suppression on purpose, that is fine: bump EXPECTED_INLINE_SUPPRESSIONS in ` +
      `scripts/check-cache-poisoning-suppressions.mjs (and say in the commit which step it covers). ` +
      `If you did not add one, a suppression appeared or vanished without review, which is what this ` +
      `exact count exists to notice — checkHygiene only ever notices zero.`,
  )
}

/**
 * #3960 (review note 5) — the `zizmor` prek hook's `files` pattern covers
 * `.github/workflows/**` and `.github/actions/**`, NOT `.github/zizmor.yml`,
 * so editing the config alone never re-runs zizmor. In practice this guard's
 * own self-test hook covers it, because that hook IS keyed to the config. So
 * the coverage is real but indirect, and an indirect dependency that nothing
 * asserts is one `files` edit away from disappearing in silence.
 */
function selfTestSelfTestHookCoverage({ check }) {
  // The reader first, on a fixture, so the assertion below is known to be
  // able to fail rather than agreeing with a regex it mis-parsed.
  const fixture = [
    '[[repos.hooks]]',
    'id = "some-hook"',
    'files = "^(scripts/a\\\\.mjs|\\\\.github/b\\\\.yml)$"',
    'stages = ["pre-commit"]',
    '',
    '[[repos.hooks]]',
    'id = "other-hook"',
    'files = "^never\\\\.txt$"',
  ].join('\n')
  const parsed = findHookFilesPattern(fixture, 'some-hook')
  check(
    parsed.test('scripts/a.mjs') &&
      parsed.test('.github/b.yml') &&
      !parsed.test('scriptsXa.mjs') &&
      !parsed.test('never.txt'),
    'a prek `files` pattern is read back as the regex prek itself would use (TOML backslash escaping survives, and the right hook block is picked)',
    String(parsed),
  )
  for (const [label, hookId] of [
    ['an unknown hook id', 'no-such-hook'],
    ['a hook with no `files` pattern', 'always-run-hook'],
  ]) {
    let threw = null
    try {
      findHookFilesPattern(`${fixture}\n\n[[repos.hooks]]\nid = "always-run-hook"\n`, hookId)
    } catch (err) {
      threw = err
    }
    check(threw !== null, `the prek reader throws on ${label} instead of passing vacuously`, '')
  }

  const pattern = findHookFilesPattern(readFileSync(PREK_CONFIG_PATH, 'utf8'), SELF_TEST_HOOK_ID)
  const missing = SELF_TEST_HOOK_DEPENDENCIES.filter((p) => !pattern.test(p))
  check(
    missing.length === 0,
    `the \`${SELF_TEST_HOOK_ID}\` prek hook still fires for every file this guard depends on (it is what re-runs zizmor when .github/zizmor.yml changes)`,
    `${String(pattern)} does not match: ${missing.join(', ')}`,
  )
}

function selfTestHygiene({ check }) {
  check(
    checkHygiene({ lineAnchors: [], inlineHits: [{ location: 'a.yml:1' }] }).length === 0,
    'no line anchors + at least one inline suppression → healthy',
    '',
  )
  check(
    checkHygiene({ lineAnchors: ['ci.yml:318'], inlineHits: [{ location: 'a.yml:1' }] }).length ===
      1,
    'a reintroduced line anchor is caught even when inline suppressions also exist',
    '',
  )
  check(
    checkHygiene({ lineAnchors: [], inlineHits: [] }).length === 1,
    'zero inline suppressions found at all is a FAILURE (wiring guard), not a vacuous pass',
    '',
  )
}

/**
 * The `filename:LINE` numbers zizmor reported for `cache-poisoning` findings
 * ONLY, read out of its human-readable output.
 *
 * zizmor prints one `error[rule-id]: …` header per finding, then an indented
 * `--> path/file.yml:LINE:COL` beneath it, so the rule id is carried by the
 * most recent header line. The negative control feeds these numbers into a
 * `rules: / cache-poisoning: / ignore:` list, which suppresses nothing at all
 * for any other rule id — so harvesting indiscriminately would silently
 * degrade the control the moment ci.yml grows a finding from a second audit.
 * Today it has none, which is exactly why this is easy to get wrong.
 *
 * ANSI escapes are stripped first. zizmor colourises when it believes the
 * consumer renders colour, and it believes that under `GITHUB_ACTIONS=true`
 * even with no TTY — so on CI the header arrived as `\x1B[1m\x1B[91merror[…`
 * and `^\s*[a-z]+\[` did not match it. Every location then read as belonging
 * to no rule, the harvest came back empty, and the control failed claiming
 * zizmor had reported nothing while its output sat in the failure message
 * listing four findings. `runZizmor` also passes `--color=never`, which is
 * the root fix; this strip is what keeps the parser correct for any caller
 * that does not.
 */
export function findCachePoisoningFindingLines(zizmorOutput, fileName) {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const locationRe = new RegExp(`-->\\s*(?:\\S*[\\\\/])?${escaped}:(\\d+):\\d+`)
  const headerRe = /^\s*[a-z]+\[([a-z0-9-]+)\]/
  // eslint-disable-next-line no-control-regex -- matching CSI sequences requires them
  const ansiRe = /\x1B\[[0-9;]*m/g
  let currentRule = null
  const lines = []
  for (const raw of zizmorOutput.split('\n')) {
    const line = raw.replace(ansiRe, '')
    const header = headerRe.exec(line)
    if (header) {
      currentRule = header[1]
      continue
    }
    const location = locationRe.exec(line)
    if (location && currentRule === 'cache-poisoning') lines.push(Number(location[1]))
  }
  return lines
}

/**
 * The property #3737 actually asks for: a suppression on a step in ci.yml
 * SURVIVES an unrelated comment inserted above it, driven against the real
 * `zizmor` binary (not a re-implementation of its heuristics). Includes a
 * negative control on the OLD line-anchored shape, so this test is proven
 * to be able to fail, not just pass vacuously.
 */
function selfTestZizmorSurvivesLineDrift({ check, fail }) {
  let zizmorVersion
  try {
    zizmorVersion = execFileSync('zizmor', ['--version'], { encoding: 'utf8' }).trim()
  } catch (err) {
    fail(
      'zizmor binary is on PATH (required for this self-test to prove anything)',
      err.message ?? String(err),
    )
    return
  }
  console.log(`  ..  using ${zizmorVersion} for the live self-test`)

  const runZizmor = (configPath, targetPath) => {
    try {
      // `--color=never` because zizmor's `auto` resolves to COLOUR under
      // `GITHUB_ACTIONS=true` regardless of TTY, and this self-test parses the
      // human-readable output. Without it the control passes locally and fails
      // only on CI — which is exactly how it shipped.
      execFileSync(
        'zizmor',
        ['--no-online-audits', '--color=never', '-c', configPath, targetPath],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') }
    }
  }

  const insertCommentLines = (text, n) => {
    const lines = text.split('\n')
    const onIdx = lines.findIndex((l) => l.startsWith('on:'))
    const insertAt = onIdx === -1 ? 1 : onIdx
    const inserted = Array.from(
      { length: n },
      (_, i) => `# self-test: unrelated comment line ${i + 1} inserted to drift every line below`,
    )
    lines.splice(insertAt, 0, ...inserted)
    return lines.join('\n')
  }

  // --- Positive case: today's real fix (inline suppressions) --------------
  {
    const dir = mkdtempSync(join(tmpdir(), 'cache-poisoning-live-'))
    const configCopy = join(dir, 'zizmor.yml')
    const ciCopy = join(dir, 'ci.yml')
    copyFileSync(ZIZMOR_CONFIG_PATH, configCopy)
    copyFileSync(CI_YML_PATH, ciCopy)

    const baseline = runZizmor(configCopy, ciCopy)
    check(
      baseline.ok,
      'live zizmor: the real ci.yml + zizmor.yml pair is clean today (baseline)',
      baseline.output ?? '',
    )

    const driftedText = insertCommentLines(readFileSync(ciCopy, 'utf8'), 12)
    writeFileSync(ciCopy, driftedText, 'utf8')
    const afterDrift = runZizmor(configCopy, ciCopy)
    check(
      afterDrift.ok,
      'live zizmor: inserting 12 unrelated comment lines above `on:` does NOT reintroduce the cache-poisoning findings (line-drift immunity)',
      afterDrift.output ?? '',
    )
  }

  // --- Negative control: the OLD line-anchored shape, to prove this test --
  // --- can actually fail, not just pass by construction. -------------------
  {
    const dir = mkdtempSync(join(tmpdir(), 'cache-poisoning-live-negative-'))
    const ciCopy = join(dir, 'ci.yml')
    copyFileSync(CI_YML_PATH, ciCopy)
    // Strip today's CACHE-POISONING inline suppressions so the OLD anchor
    // style is the only thing suppressing them — otherwise the inline
    // comments (which stay in the copy) would mask the regression this
    // control exists to demonstrate. Suppressions for OTHER rules are left
    // in place: this control is about cache-poisoning only, and deleting an
    // unrelated one would surface its finding below, where every finding is
    // harvested into a `cache-poisoning:` ignore list.
    const withoutInlineSuppressions = readFileSync(ciCopy, 'utf8')
      .split('\n')
      .filter((l) => !ignoresCachePoisoning(l))
      .join('\n')
    writeFileSync(ciCopy, withoutInlineSuppressions, 'utf8')

    // Find today's four cache-poisoning line numbers the OLD way zizmor.yml
    // used to: run with an empty ignore list and read the finding lines back.
    // Only cache-poisoning findings count — zizmor prints `error[rule-id]:`
    // above each `-->` location, and harvesting every location regardless of
    // rule would put some other audit's line into a `cache-poisoning:` ignore
    // list, where it suppresses nothing and quietly weakens the control.
    const emptyConfig = join(dir, 'zizmor-empty.yml')
    writeFileSync(emptyConfig, 'rules: {}\n', 'utf8')
    const clean = runZizmor(emptyConfig, ciCopy)
    const lineMatches = findCachePoisoningFindingLines(clean.output ?? '', 'ci.yml')
    if (lineMatches.length === 0) {
      fail(
        'negative control: could derive the current cache-poisoning line numbers from a real zizmor run',
        clean.output ?? '(no output captured)',
      )
      return
    }

    const oldStyleConfig = join(dir, 'zizmor-old-style.yml')
    writeFileSync(
      oldStyleConfig,
      [
        'rules:',
        '  cache-poisoning:',
        '    ignore:',
        ...lineMatches.map((n) => `      - ci.yml:${n}`),
        '',
      ].join('\n'),
      'utf8',
    )
    const oldStyleBaseline = runZizmor(oldStyleConfig, ciCopy)
    check(
      oldStyleBaseline.ok,
      'negative control: the OLD line-anchored style is clean before any drift (sanity check on the derived anchors)',
      oldStyleBaseline.output ?? '',
    )

    const driftedText = insertCommentLines(readFileSync(ciCopy, 'utf8'), 12)
    writeFileSync(ciCopy, driftedText, 'utf8')
    const oldStyleAfterDrift = runZizmor(oldStyleConfig, ciCopy)
    check(
      !oldStyleAfterDrift.ok,
      'negative control: the OLD line-anchored style DOES break under the same 12-line drift — proving this self-test can fail, not just pass vacuously',
      oldStyleAfterDrift.ok
        ? '(zizmor stayed clean — the control did not reproduce #3737)'
        : oldStyleAfterDrift.output,
    )
  }
}

/**
 * #3960 — the negative control derives its line-anchor list from zizmor's
 * own output, so the harvest must be rule-aware. Driven against captured
 * output text rather than a live run: the point is the parse, and today's
 * ci.yml emits no second rule to parse.
 */
function selfTestFindingLineHarvest({ check }) {
  const output = [
    'error[cache-poisoning]: runtime artifacts potentially vulnerable to a cache poisoning attack',
    '   --> /tmp/x/ci.yml:323:9',
    '    |',
    'error[unpinned-uses]: unpinned action reference',
    '   --> /tmp/x/ci.yml:77:9',
    '    |',
    'error[cache-poisoning]: runtime artifacts potentially vulnerable to a cache poisoning attack',
    '   --> /tmp/x/ci.yml:349:9',
    '',
  ].join('\n')
  const lines = findCachePoisoningFindingLines(output, 'ci.yml')
  check(
    lines.length === 2 && lines[0] === 323 && lines[1] === 349,
    'only cache-poisoning finding lines are harvested — another rule’s line never enters the cache-poisoning ignore list',
    JSON.stringify(lines),
  )
  check(
    findCachePoisoningFindingLines(output, 'other.yml').length === 0,
    'a location in a different file is not harvested',
    '',
  )
  // The exact bytes zizmor emitted on CI, where `--color auto` resolves to
  // colour under GITHUB_ACTIONS with no TTY. Pre-fix this harvested nothing:
  // the escape prefix put the rule-id header out of reach of `^\s*[a-z]+\[`,
  // so every location below it belonged to no rule.
  const colorized = [
    '\x1B[1m\x1B[91merror[cache-poisoning]\x1B[0m\x1B[1m: runtime artifacts potentially vulnerable to a cache poisoning attack\x1B[0m',
    ' \x1B[1m\x1B[94m--> \x1B[0m/tmp/x/ci.yml:323:9',
    '\x1B[1m\x1B[91merror[unpinned-uses]\x1B[0m\x1B[1m: unpinned action reference\x1B[0m',
    ' \x1B[1m\x1B[94m--> \x1B[0m/tmp/x/ci.yml:77:9',
    '',
  ].join('\n')
  const colorizedLines = findCachePoisoningFindingLines(colorized, 'ci.yml')
  check(
    colorizedLines.length === 1 && colorizedLines[0] === 323,
    'colourised zizmor output is harvested identically — and the other rule is still excluded',
    JSON.stringify(colorizedLines),
  )
  check(
    findCachePoisoningFindingLines('', 'ci.yml').length === 0,
    'empty zizmor output harvests nothing (the caller treats zero as a control failure)',
    '',
  )
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok  - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail))

  selfTestLineAnchorDetection({ check })
  selfTestInlineScan({ check })
  selfTestHygiene({ check })
  selfTestSelfTestHookCoverage({ check })
  selfTestFindingLineHarvest({ check })
  selfTestZizmorSurvivesLineDrift({ check, fail })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`check-cache-poisoning-suppressions: ${err.message}`)
      process.exit(1)
    }
  }
}
