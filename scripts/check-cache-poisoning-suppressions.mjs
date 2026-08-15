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
 */
export function findLineAnchoredCachePoisoningIgnores(zizmorYmlText) {
  const lines = zizmorYmlText.split('\n')
  const ruleLineIdx = lines.findIndex((l) => /^\s{2}cache-poisoning:\s*$/.test(l))
  if (ruleLineIdx === -1) return []

  const ruleIndent = lines[ruleLineIdx].match(/^(\s*)/)[1].length
  const anchors = []
  for (let i = ruleLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.match(/^(\s*)/)[1].length
    // Dedented back to (or past) the `cache-poisoning:` key's own indent —
    // its block has ended.
    if (indent <= ruleIndent && line.trim() !== '') break
    const m = line.match(/^\s*-\s*([^\s#]+\.ya?ml:\d+(?::\d+)?)\s*(?:#.*)?$/)
    if (m) anchors.push(m[1])
  }
  return anchors
}

// ---------------------------------------------------------------------------
// (2) Inventory of the inline suppressions that replaced the anchor list.
// ---------------------------------------------------------------------------

const INLINE_IGNORE_RE = /#\s*zizmor:\s*ignore\[([^\]]*)\]/

/**
 * Every `# zizmor: ignore[...]` comment naming `cache-poisoning` found
 * across `.github/workflows/**`, as `{ location }` (`file:line`). Scans ALL
 * workflow files, not a hardcoded filename list, for the same reason
 * `check-zizmor-version-pin.mjs`'s `findZizmorToolPins` does: a suppression
 * moved or added to a different workflow is covered automatically.
 */
export function findInlineCachePoisoningSuppressions(dir = WORKFLOWS_DIR) {
  if (!existsSync(dir)) throw new Error(`no workflow directory at ${dir}`)
  const files = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
  const hits = []
  for (const name of files.toSorted()) {
    const text = readFileSync(join(dir, name), 'utf8')
    text.split('\n').forEach((line, idx) => {
      const m = line.match(INLINE_IGNORE_RE)
      if (!m) return
      const rules = m[1]
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
      if (rules.includes('cache-poisoning')) {
        hits.push({ location: `${name}:${idx + 1}` })
      }
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

  // ...and the real repo, right now, must have the four this fix introduced.
  const realHits = findInlineCachePoisoningSuppressions()
  check(
    realHits.length === 4,
    'the real .github/workflows/** has exactly the four inline cache-poisoning suppressions #3737 introduced',
    JSON.stringify(realHits),
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
      execFileSync('zizmor', ['--no-online-audits', '-c', configPath, targetPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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
    // Strip today's inline suppressions so the OLD anchor style is the only
    // thing suppressing anything — otherwise the inline comments (which
    // stay in the copy) would mask the regression this control exists to
    // demonstrate.
    const withoutInlineSuppressions = readFileSync(ciCopy, 'utf8')
      .split('\n')
      .filter((l) => !INLINE_IGNORE_RE.test(l))
      .join('\n')
    writeFileSync(ciCopy, withoutInlineSuppressions, 'utf8')

    // Find today's four cache-poisoning line numbers the OLD way zizmor.yml
    // used to: run with an empty ignore list and read the finding lines back.
    const emptyConfig = join(dir, 'zizmor-empty.yml')
    writeFileSync(emptyConfig, 'rules: {}\n', 'utf8')
    const clean = runZizmor(emptyConfig, ciCopy)
    const lineMatches = [...(clean.output ?? '').matchAll(/--> .*ci\.yml:(\d+):\d+/g)].map((m) =>
      Number(m[1]),
    )
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
