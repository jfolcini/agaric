#!/usr/bin/env node
// #3523 — zizmor's pinned version (#3476) lives in several independent
// places, and Dependabot's `github-actions` ecosystem cannot track any of
// them:
//
//   * `scripts/zizmor-hook.sh` — `ZIZMOR_PINNED_VERSION`, the value the
//     local-hook wrapper asserts the installed `zizmor --version` against.
//   * every `taiki-e/install-action` `tool:` list in `.github/workflows/**`
//     that names zizmor (today: two occurrences in
//     `scheduled-deep-checks.yml`, one in `_validate.yml`) — a plain
//     comma-separated STRING passed as an action `with:` input, not an
//     action ref, so Dependabot's ref-bumping has nothing to grab onto. The
//     pre-existing `sqruff@0.38.0` pin in the same lists has the identical
//     blind spot; this is not new with zizmor.
//
// A FOURTH site sits outside this guard's scope: `scripts/setup-hooks.sh`'s
// `cargo_get zizmor`, which installs unpinned. It is not checked here
// because a `cargo install` invocation is not a version declaration to
// compare against — the hook wrapper's own runtime `--version` assertion is
// what catches a wrong binary from that path. Named so the next person
// pinning a version knows it exists.
//
// Nothing connects these. A bump applied to one and missed in another is a
// SILENT drift: CI still runs a `zizmor` binary, just not the one anyone
// thinks it's running, and (per #3523's own "mitigating factors") the
// online-degradation gap #3476 closed does not re-open — the failure mode is
// a red pre-push wrapper assertion on the NEXT commit that happens to touch
// a workflow, not a silently-passing check. This guard moves that from
// "eventually red, on an unrelated commit" to "red right now, on the commit
// that caused it."
//
// Deliberately NOT "reduce to one place" (#3523's option 3): the wrapper
// script needs the version at shell-variable scope to assert against a
// locally-installed binary, and `taiki-e/install-action`'s `tool:` input
// needs it at YAML-string scope to provision a binary in a fresh runner —
// two different consumers, two different places. This guard makes the
// duplication SAFE (a guard that fails when the places disagree) rather
// than eliminating it, per the issue's own read that the three-place layout
// is a deliberate, non-urgent cost, not a bug to design away.
//
// ─── Why "no pin anywhere" passes ────────────────────────────────────────
//
// This repo's `main` (as of writing) has NOT yet merged the PR that
// introduces `ZIZMOR_PINNED_VERSION` and the `zizmor@X` tool-list pins —
// today every `tool:` list still names bare `zizmor` and the hook script
// declares no `ZIZMOR_PINNED_VERSION` at all. That is a consistent state
// (nothing pinned anywhere), not drift, so it must read as healthy: the
// alternative — treating "unpinned" as automatically wrong — would make
// this guard fail on `main` today, before the very thing it protects even
// exists. Once the pin lands, every place must agree; until then, agreeing
// on "nothing pinned" is still agreement.
//
// ─── Why an empty tool-list scan throws instead of passing ──────────────
//
// If zizmor's `tool:` entry is ever renamed, reworded, or the workflows
// restructured so no line matches, this guard would otherwise report "zero
// places, zero disagreements" — green by construction, forever, on exactly
// the kind of desync #3374's wiring guards exist to catch. So finding no
// occurrence at all in `.github/workflows/**` is itself a failure: it means
// this script fell out of step with the repo, not that there is nothing to
// check.
//
// Usage:
//   node scripts/check-zizmor-version-pin.mjs
//   node scripts/check-zizmor-version-pin.mjs --self-test
//
// Exit codes: 0 = every place agrees; 1 = a real disagreement (or the
// wiring guard above); 2 = self-test failure.

import {
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
const WORKFLOWS_DIR = join(SCRIPTS_DIR, '..', '.github', 'workflows')
const HOOK_PATH = join(SCRIPTS_DIR, 'zizmor-hook.sh')

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * `ZIZMOR_PINNED_VERSION="X"` from the hook script text, or `null` when the
 * variable is not declared at all (today's pre-pin state on `main`).
 */
export function extractHookPin(hookText) {
  const m = hookText.match(/^\s*ZIZMOR_PINNED_VERSION="([^"]*)"/m)
  if (!m) return null
  return m[1].length > 0 ? m[1] : null
}

/**
 * A YAML block-scalar indicator (`|`, `|-`, `|+2`, `>`, `>1-`, …) as the
 * entire (post-comment-stripped) `tool:` value. That means the real value
 * lives on the FOLLOWING indented lines, which this single-line scanner
 * cannot see.
 */
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/

/**
 * Given ONE `tool:` line's value (e.g. `prek,zizmor,taplo-cli,sqruff@0.38.0`),
 * returns `{ version }` for the zizmor entry (`version` is `null` when zizmor
 * is present but bare), or `undefined` when the line has no zizmor entry —
 * `tool:` lines for other steps (e.g. a plain `sqruff@0.38.0` install with no
 * zizmor at all) must not be mistaken for a zizmor pin site.
 *
 * Throws when the `tool:` value is a shape this line-based parser cannot
 * represent (a YAML block scalar). That is deliberate (#3538): this parser
 * is line- and entry-exact, so a shape it cannot read must fail LOUD rather
 * than silently return `undefined` — which reads identically to "no tool:
 * on this line" and would let a drifted zizmor pin inside the block go
 * completely unseen, contributing nothing to the version set the wiring
 * guard below compares (a false negative, not a total miss, so nothing else
 * trips).
 */
export function parseZizmorFromToolLine(line) {
  const m = line.match(/(?:^|\s)tool:\s*(\S.*?)\s*$/)
  if (!m) return undefined
  // Strip a trailing YAML comment (a `#` preceded by whitespace) before
  // splitting on commas. Without this, a comment glued onto the last entry
  // (`tool: prek,zizmor@1.28.0  # pinned`) makes that entry read
  // `zizmor@1.28.0  # pinned`, which fails the exact `^zizmor(?:@(\S+))?$`
  // match below — so the whole line silently parsed as "no zizmor entry at
  // all" (#3538) instead of extracting the pin that is right there.
  const value = m[1].replace(/\s+#.*$/, '').trim()
  if (BLOCK_SCALAR_RE.test(value)) {
    throw new Error(
      `tool: value on this line is a YAML block scalar ("${value}") that parseZizmorFromToolLine cannot read — ` +
        'give it a single-line value, or teach this parser to follow block scalars',
    )
  }
  const entries = value.split(',').map((e) => e.trim())
  for (const entry of entries) {
    const em = entry.match(/^zizmor(?:@(\S+))?$/)
    if (em) return { version: em[1] ?? null }
  }
  return undefined
}

/**
 * Every zizmor pin site found across `.github/workflows/**`, as
 * `{ location, version }`. Scans ALL workflow files (not a hardcoded
 * filename list) so a zizmor `tool:` entry added to a new workflow is
 * covered automatically — no separate wiring list to keep in sync, unlike
 * `check-workflow-liveness.mjs`'s WATCHED (which needs one because it also
 * carries per-workflow tuning; this guard only needs "did we find it").
 */
export function findZizmorToolPins(dir = WORKFLOWS_DIR) {
  const files = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
  const hits = []
  for (const name of files.toSorted()) {
    const text = readFileSync(join(dir, name), 'utf8')
    text.split('\n').forEach((line, idx) => {
      let parsed
      try {
        parsed = parseZizmorFromToolLine(line)
      } catch (err) {
        // Re-throw with file:line context — parseZizmorFromToolLine itself
        // has no idea which file or line it was given.
        throw new Error(`${name}:${idx + 1}: ${err.message}`)
      }
      if (parsed) {
        hits.push({ location: `${name}:${idx + 1}`, version: parsed.version })
      }
    })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Compares the hook's pin against every `tool:`-list pin found. Returns an
 * array of human-readable problem strings — empty means consistent.
 */
export function checkConsistency({ hookPin, toolHits }) {
  const problems = []
  if (toolHits.length === 0) {
    problems.push(
      'no `taiki-e/install-action` `tool:` list in .github/workflows/** names zizmor at all — ' +
        'either the wiring this guard checks has moved/been renamed (update this script), ' +
        'or zizmor was removed from CI entirely (delete this guard too)',
    )
    return problems
  }

  const all = [
    { location: 'scripts/zizmor-hook.sh (ZIZMOR_PINNED_VERSION)', version: hookPin },
    ...toolHits,
  ]
  const distinct = new Set(all.map((h) => h.version ?? '(unpinned)'))
  if (distinct.size > 1) {
    problems.push(
      `zizmor's pinned version disagrees across the ${all.length} place(s) it is recorded:\n${all
        .map((h) => `      - ${h.location}: ${h.version ?? '(unpinned)'}`)
        .join('\n')}`,
    )
  }
  return problems
}

/** Throws with every disagreement spelled out, or returns silently. */
export function assertZizmorPinConsistency({
  hookPath = HOOK_PATH,
  workflowsDir = WORKFLOWS_DIR,
} = {}) {
  const hookPin = extractHookPin(readFileSync(hookPath, 'utf8'))
  const toolHits = findZizmorToolPins(workflowsDir)
  const problems = checkConsistency({ hookPin, toolHits })
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-zizmor-version-pin.mjs found the zizmor version pin out of sync (#3523):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return { hookPin, toolHits }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { hookPin, toolHits } = assertZizmorPinConsistency()
  const state = hookPin === null ? 'unpinned everywhere' : `pinned to ${hookPin} everywhere`
  console.log(
    `OK  zizmor version pin: ${state} (${1 + toolHits.length} place(s) checked: scripts/zizmor-hook.sh + ${toolHits.length} tool: list site(s))`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function selfTestExtraction({ check }) {
  check(extractHookPin('foo=bar\n') === null, 'no ZIZMOR_PINNED_VERSION declared → null', '')
  check(
    extractHookPin('ZIZMOR_PINNED_VERSION="1.28.0"\n') === '1.28.0',
    'ZIZMOR_PINNED_VERSION is extracted verbatim',
    extractHookPin('ZIZMOR_PINNED_VERSION="1.28.0"\n'),
  )
  check(
    extractHookPin('  ZIZMOR_PINNED_VERSION="1.28.0"  # pinned, see #3476\n') === '1.28.0',
    'extraction tolerates leading whitespace and a trailing comment on the line',
    '',
  )
  check(
    extractHookPin('ZIZMOR_PINNED_VERSION=""\n') === null,
    'an explicitly EMPTY pin reads the same as unpinned, not as version ""',
    '',
  )

  check(
    parseZizmorFromToolLine('        tool: prek,zizmor,taplo-cli')?.version === null,
    'a bare zizmor entry parses as version: null',
    JSON.stringify(parseZizmorFromToolLine('        tool: prek,zizmor,taplo-cli')),
  )
  check(
    parseZizmorFromToolLine('        tool: prek,zizmor@1.28.0,taplo-cli')?.version === '1.28.0',
    'a pinned zizmor entry parses its version',
    JSON.stringify(parseZizmorFromToolLine('        tool: prek,zizmor@1.28.0,taplo-cli')),
  )
  check(
    parseZizmorFromToolLine('        tool: prek,sqruff@0.38.0') === undefined,
    'a tool: line with no zizmor entry at all returns undefined, not a false positive',
    JSON.stringify(parseZizmorFromToolLine('        tool: prek,sqruff@0.38.0')),
  )
  check(
    parseZizmorFromToolLine('        run: echo zizmor') === undefined,
    'a line merely CONTAINING the word zizmor without a `tool:` prefix is not mistaken for a pin site',
    JSON.stringify(parseZizmorFromToolLine('        run: echo zizmor')),
  )
  // The bug class this guard exists to catch one level down from itself:
  // a tool NAMED e.g. "not-zizmor-cli" must not satisfy a substring match.
  check(
    parseZizmorFromToolLine('        tool: prek,not-zizmor-cli') === undefined,
    'a tool name that merely CONTAINS "zizmor" as a substring is not a match',
    JSON.stringify(parseZizmorFromToolLine('        tool: prek,not-zizmor-cli')),
  )

  // #3538 — a trailing YAML comment glued onto the last entry must not make
  // the zizmor pin invisible. Checked against the SPECIFIC version, not
  // `=== undefined || .version === null`: the pre-fix bug also returns
  // `undefined` here, so a check that merely tolerates `undefined` would
  // pass on the broken parser too and prove nothing.
  check(
    parseZizmorFromToolLine('        tool: prek,zizmor@1.28.0  # pinned')?.version === '1.28.0',
    'a trailing comment after the last entry does not swallow the zizmor pin',
    JSON.stringify(parseZizmorFromToolLine('        tool: prek,zizmor@1.28.0  # pinned')),
  )
  check(
    parseZizmorFromToolLine('        tool: zizmor  # bare, still pinned via CI default')
      ?.version === null,
    'a trailing comment after a BARE zizmor entry still parses as version: null, not undefined',
    JSON.stringify(
      parseZizmorFromToolLine('        tool: zizmor  # bare, still pinned via CI default'),
    ),
  )
  check(
    parseZizmorFromToolLine('        tool: prek,sqruff@0.38.0  # no zizmor here') === undefined,
    'a trailing comment on a line with no zizmor entry still correctly returns undefined',
    JSON.stringify(parseZizmorFromToolLine('        tool: prek,sqruff@0.38.0  # no zizmor here')),
  )

  // #3538 — a YAML block-scalar `tool:` value (the real list lives on the
  // FOLLOWING indented lines, invisible to this line scanner) must fail
  // LOUD, not return `undefined`. `undefined` is indistinguishable from "no
  // tool: on this line at all", which is exactly how a drifted pin inside
  // the block would go completely unseen.
  for (const blockValue of ['tool: |', 'tool: >', 'tool: |-', 'tool: >2']) {
    let threw = null
    try {
      parseZizmorFromToolLine(`        ${blockValue}`)
    } catch (err) {
      threw = err
    }
    check(
      threw !== null && /block scalar/.test(threw.message),
      `a YAML block-scalar tool: value ("${blockValue}") fails loud instead of silently reading as no entry`,
      threw
        ? threw.message
        : 'undefined (no throw) — indistinguishable from "no tool: on this line"',
    )
  }
}

function selfTestConsistency({ check }) {
  check(
    checkConsistency({
      hookPin: null,
      toolHits: [
        { location: 'a.yml:1', version: null },
        { location: 'b.yml:1', version: null },
      ],
    }).length === 0,
    "unpinned everywhere (today's pre-#3476-merge state on main) is consistent, not a failure",
    '',
  )
  check(
    checkConsistency({
      hookPin: '1.28.0',
      toolHits: [
        { location: 'a.yml:1', version: '1.28.0' },
        { location: 'b.yml:1', version: '1.28.0' },
        { location: 'b.yml:2', version: '1.28.0' },
      ],
    }).length === 0,
    'consistently pinned to the same version everywhere passes',
    '',
  )
  check(
    checkConsistency({ hookPin: '1.28.0', toolHits: [] }).length === 1,
    'zero tool: sites found at all is a FAILURE (wiring guard), not a vacuous pass',
    '',
  )

  // The actual drift classes #3523 is worried about — each must be caught.
  {
    const problems = checkConsistency({
      hookPin: '1.28.0',
      toolHits: [
        { location: 'a.yml:1', version: '1.28.0' },
        { location: 'b.yml:1', version: null }, // one site never got the bump
      ],
    })
    check(
      problems.length === 1 && problems[0].includes('b.yml:1'),
      'one tool: site left unpinned while the hook is pinned is caught',
      JSON.stringify(problems),
    )
  }
  {
    const problems = checkConsistency({
      hookPin: '1.28.0',
      toolHits: [
        { location: 'a.yml:1', version: '1.29.0' }, // bumped here...
        { location: 'b.yml:1', version: '1.28.0' }, // ...missed here
      ],
    })
    check(
      problems.length === 1 && problems[0].includes('1.29.0') && problems[0].includes('1.28.0'),
      'two tool: sites pinned to DIFFERENT versions is caught even when the hook agrees with neither... er, with one',
      JSON.stringify(problems),
    )
  }
  {
    const problems = checkConsistency({
      hookPin: null, // hook never got the pin added
      toolHits: [
        { location: 'a.yml:1', version: '1.28.0' },
        { location: 'b.yml:1', version: '1.28.0' },
      ],
    })
    check(
      problems.length === 1 && problems[0].includes('ZIZMOR_PINNED_VERSION'),
      'the hook itself lagging behind two already-pinned tool: sites is caught',
      JSON.stringify(problems),
    )
  }
}

/**
 * `findZizmorToolPins` against real files on disk, not just parsed lines —
 * proves the line/file scan wiring itself (which file, which line number)
 * rather than only the per-line regex.
 */
function selfTestDiskScan({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'zizmor-pin-scan-'))
  writeFileSync(
    join(dir, 'x.yml'),
    [
      'name: X',
      '      - uses: taiki-e/install-action@abc',
      '        with:',
      '          tool: prek,zizmor@1.28.0,sqruff@0.38.0',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(dir, 'y.yaml'), ['name: Y', '          tool: zizmor', ''].join('\n'), 'utf8')
  writeFileSync(join(dir, 'not-a-workflow.txt'), 'tool: zizmor@9.9.9\n', 'utf8')

  const hits = findZizmorToolPins(dir)
  check(
    hits.length === 2,
    'the scan finds exactly the zizmor entries in .yml/.yaml files, ignoring non-workflow files',
    JSON.stringify(hits),
  )
  check(
    hits.some((h) => h.location === 'x.yml:4' && h.version === '1.28.0'),
    'a pinned hit records the correct file:line and version',
    JSON.stringify(hits),
  )
  check(
    hits.some((h) => h.location === 'y.yaml:2' && h.version === null),
    'a bare hit records version: null with the correct file:line',
    JSON.stringify(hits),
  )

  // #3538 — a trailing comment on disk (not just as a hand-built string) is
  // still found by the real file scan.
  const commentDir = mkdtempSync(join(tmpdir(), 'zizmor-pin-scan-comment-'))
  writeFileSync(
    join(commentDir, 'c.yml'),
    ['name: C', '          tool: prek,zizmor@1.30.0  # pinned, see #3476', ''].join('\n'),
    'utf8',
  )
  const commentHits = findZizmorToolPins(commentDir)
  check(
    commentHits.some((h) => h.location === 'c.yml:2' && h.version === '1.30.0'),
    'a zizmor pin followed by a trailing comment is found by the real file scan, not silently dropped',
    JSON.stringify(commentHits),
  )

  // #3538 — a block-scalar tool: value on disk makes the SCAN throw (not
  // return an empty/partial hit list), and the error names the offending
  // file:line so a maintainer can find it immediately.
  const blockDir = mkdtempSync(join(tmpdir(), 'zizmor-pin-scan-block-'))
  writeFileSync(
    join(blockDir, 'd.yml'),
    ['name: D', '        with:', '          tool: |', '            zizmor@1.30.0', ''].join('\n'),
    'utf8',
  )
  let blockThrew = null
  try {
    findZizmorToolPins(blockDir)
  } catch (err) {
    blockThrew = err
  }
  check(
    blockThrew !== null &&
      blockThrew.message.includes('d.yml:3') &&
      /block scalar/.test(blockThrew.message),
    'a block-scalar tool: value found during the real file scan fails loud and names its file:line',
    blockThrew ? blockThrew.message : 'undefined (no throw)',
  )
}

/** `assertZizmorPinConsistency` end-to-end against fixture files, then real disk. */
function selfTestEndToEnd({ check, fail }) {
  const dir = mkdtempSync(join(tmpdir(), 'zizmor-pin-e2e-'))
  const hookPath = join(dir, 'zizmor-hook.sh')
  const workflowsDir = join(dir, 'workflows')
  mkdirSync(workflowsDir, { recursive: true })

  writeFileSync(hookPath, '#!/usr/bin/env bash\nZIZMOR_PINNED_VERSION="1.28.0"\n', 'utf8')
  writeFileSync(
    join(workflowsDir, 'a.yml'),
    '          tool: prek,zizmor@1.28.0,sqruff@0.38.0\n',
    'utf8',
  )
  let threw = null
  try {
    assertZizmorPinConsistency({ hookPath, workflowsDir })
  } catch (err) {
    threw = err
  }
  check(threw === null, 'end-to-end: a consistent fixture does not throw', threw?.message)

  writeFileSync(join(workflowsDir, 'b.yml'), '          tool: prek,zizmor,sqruff@0.38.0\n', 'utf8')
  threw = null
  try {
    assertZizmorPinConsistency({ hookPath, workflowsDir })
  } catch (err) {
    threw = err
  }
  check(
    threw !== null && threw.message.includes('b.yml'),
    'end-to-end: introducing a drifted fixture DOES throw, and names the offending site',
    threw?.message ?? '(no throw)',
  )

  // …and the real repo, as it stands right now, must itself be consistent.
  try {
    const { hookPin, toolHits } = assertZizmorPinConsistency()
    check(
      true,
      `the real repo's zizmor pin is consistent (hookPin=${hookPin === null ? '(unpinned)' : hookPin}, ${toolHits.length} tool: site(s))`,
      '',
    )
  } catch (err) {
    fail("the real repo's zizmor pin is consistent", err.message)
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

  selfTestExtraction({ check })
  selfTestConsistency({ check })
  selfTestDiskScan({ check })
  selfTestEndToEnd({ check, fail })

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
      console.error(`check-zizmor-version-pin: ${err.message}`)
      process.exit(1)
    }
  }
}
