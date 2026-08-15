#!/usr/bin/env node
// #3742 — prek/taplo-cli/typos-cli's pinned versions live in several
// independent places, same shape as zizmor's #3523 (see
// scripts/check-zizmor-version-pin.mjs, whose structure this mirrors):
//
//   * `scripts/setup-hooks.sh`'s `pinned_version_for()` — the DATA table a
//     pinned crate's `cargo_get_pinned` call site reads to install the
//     EXACT version locally, replacing a different one already on PATH.
//   * every `taiki-e/install-action` `tool:` list in `.github/workflows/**`
//     naming one of these three tools — a plain comma-separated STRING
//     passed as an action `with:` input, not an action ref, so
//     Dependabot's ref-bumping has nothing to grab onto (the pre-existing
//     `sqruff@0.38.0` / `zizmor@1.28.0` pins have the identical blind spot;
//     this is not new).
//
// Nothing connects these two places automatically. A bump applied to one
// and missed in the other is a SILENT drift: CI resolves one version, a
// developer's box installs another, and the two disagree about what passes
// — precisely the failure #3742 hit live. `.github/zizmor.yml` went red on
// a YAML comment-count parser limit that CI's (unpinned, at the time)
// resolved prek enforced and the locally-installed prek did not: a green
// tree went red with no repo change, and the fix that passed locally still
// failed in CI, unreproducible by construction until the two matched.
//
// Why prek needed a DIFFERENT local-honesty mechanism than zizmor (#3523's
// `ZIZMOR_PINNED_VERSION` + zizmor-hook.sh's runtime `--version` assertion):
// prek IS the hook runner. There is no wrapper script standing between it
// and the developer the way zizmor-hook.sh stands in front of zizmor, so
// there is nothing to assert a runtime version match at hook-invocation
// time. The fix instead lives entirely on the INSTALL side:
// `pinned_version_for`'s entries route prek/taplo-cli/typos-cli through
// `cargo_get_pinned` (which installs the exact pin and REPLACES a wrong
// version already on PATH — see setup-hooks.sh's #3611 history), so a
// freshly-provisioned box cannot silently diverge from what this guard
// checks CI resolves.
//
// ─── Why "no pin anywhere" would read as healthy, but doesn't apply here ──
//
// Unlike zizmor's guard (which has to tolerate main's pre-#3476 unpinned
// state), prek/taplo-cli/typos-cli are pinned in EVERY place from the
// moment #3742 landed — there is no historical "nothing pinned yet" state
// to stay compatible with. So this guard treats "some places pinned, others
// not" as drift for these three tools without the zizmor guard's
// "unpinned-everywhere is fine" carve-out. If a tool is ever deliberately
// unpinned again, update this comment and the logic together — don't just
// weaken the check silently.
//
// Usage:
//   node scripts/check-prek-version-pin.mjs
//   node scripts/check-prek-version-pin.mjs --self-test
//
// Exit codes: 0 = every place agrees for all three tools; 1 = a real
// disagreement (or the wiring guard below); 2 = self-test failure.

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
const SETUP_HOOKS_PATH = join(SCRIPTS_DIR, 'setup-hooks.sh')

// The tools this guard tracks. Each must have a `<name>) echo "X.Y.Z" ;;`
// arm in setup-hooks.sh's `pinned_version_for()`, and each is looked for as
// a `<name>@X.Y.Z` (or bare `<name>`) entry in every workflow `tool:` list.
export const TRACKED_TOOLS = ['prek', 'taplo-cli', 'typos-cli']

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * `<tool>) echo "X.Y.Z" ;;` from `pinned_version_for()`'s case-statement
 * body, or `null` when that tool has no arm at all (unpinned). Restricted to
 * the FIRST match per tool so a stray later mention (e.g. inside a comment
 * quoting the pattern) cannot be picked up as the real entry — the same
 * "first occurrence wins" discipline check-zizmor-version-pin.mjs's
 * `extractHookPin` uses via its `^...$/m` anchor.
 */
export function extractPinnedVersionFor(setupHooksText, tool) {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\)\\s*echo\\s+"([^"]*)"\\s*;;`, 'm')
  const m = setupHooksText.match(re)
  if (!m) return null
  return m[1].length > 0 ? m[1] : null
}

/**
 * Given ONE `tool:` line's value, returns `{ version }` for the named
 * tool's entry (`version: null` for a bare entry), or `undefined` when the
 * line has no entry for it at all. Mirrors
 * `check-zizmor-version-pin.mjs`'s `parseZizmorFromToolLine`, generalised to
 * an arbitrary tool name — including the same block-scalar loud-failure and
 * trailing-comment handling, because a `tool:` list can carry both zizmor
 * and any of these three tools on the identical line and must parse
 * identically either way.
 */
const BLOCK_SCALAR_RE = /^[|>](?:[+-]\d*|\d+[+-]?)?$/

export function parseToolFromToolLine(line, tool) {
  const m = line.match(/(?:^|\s)tool:\s*(\S.*?)\s*$/)
  if (!m) return undefined
  const value = m[1].replace(/\s+#.*$/, '').trim()
  if (BLOCK_SCALAR_RE.test(value)) {
    throw new Error(
      `tool: value on this line is a YAML block scalar ("${value}") that parseToolFromToolLine cannot read — ` +
        'give it a single-line value, or teach this parser to follow block scalars',
    )
  }
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const entryRe = new RegExp(`^${escaped}(?:@(\\S+))?$`)
  for (const entry of value.split(',').map((e) => e.trim())) {
    const em = entry.match(entryRe)
    if (em) return { version: em[1] ?? null }
  }
  return undefined
}

/**
 * Every `tool:` pin site for `tool` found across `.github/workflows/**`, as
 * `{ location, version }`. Scans ALL workflow files, not a hardcoded
 * filename list, so a new workflow adding one of these tools is covered
 * automatically.
 */
export function findToolPins(tool, dir = WORKFLOWS_DIR) {
  const files = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
  const hits = []
  for (const name of files.toSorted()) {
    const text = readFileSync(join(dir, name), 'utf8')
    text.split('\n').forEach((line, idx) => {
      let parsed
      try {
        parsed = parseToolFromToolLine(line, tool)
      } catch (err) {
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

/** Compares one tool's `pinned_version_for` value against every `tool:`-list
 * pin found for it. Returns an array of human-readable problem strings —
 * empty means consistent. Unlike the zizmor guard, an all-unpinned outcome
 * is NOT treated as healthy here (see the header) — every place must carry
 * the same real version. */
export function checkToolConsistency(tool, { pinnedVersion, toolHits }) {
  const problems = []
  if (toolHits.length === 0) {
    problems.push(
      `no taiki-e/install-action \`tool:\` list in .github/workflows/** names ${tool} at all — ` +
        'either the wiring this guard checks has moved/been renamed (update this script), or ' +
        'the tool was removed from CI entirely (delete it from TRACKED_TOOLS too)',
    )
    return problems
  }
  const all = [
    { location: `scripts/setup-hooks.sh (pinned_version_for ${tool})`, version: pinnedVersion },
    ...toolHits,
  ]
  const distinct = new Set(all.map((h) => h.version ?? '(unpinned)'))
  if (distinct.size > 1) {
    problems.push(
      `${tool}'s pinned version disagrees across the ${all.length} place(s) it is recorded:\n${all
        .map((h) => `      - ${h.location}: ${h.version ?? '(unpinned)'}`)
        .join('\n')}`,
    )
  } else if (pinnedVersion === null) {
    // Every place agrees, but that agreement is "nobody pinned it" — the
    // header explains why that does not read as healthy for these three
    // tools specifically (unlike zizmor's pre-#3476 history).
    problems.push(
      `${tool} is unpinned everywhere (setup-hooks.sh AND every tool: list agree, but on ` +
        'nothing) — #3742 exists because an unpinned prek let CI float away from what a dev box ' +
        'had installed; add a pinned_version_for entry and matching tool: pins instead of ' +
        'leaving this tool unpinned',
    )
  }
  return problems
}

/** Throws with every disagreement (across ALL tracked tools) spelled out, or
 * returns silently. */
export function assertPrekVersionPinConsistency({
  setupHooksPath = SETUP_HOOKS_PATH,
  workflowsDir = WORKFLOWS_DIR,
  tools = TRACKED_TOOLS,
} = {}) {
  const setupHooksText = readFileSync(setupHooksPath, 'utf8')
  const results = {}
  const problems = []
  for (const tool of tools) {
    const pinnedVersion = extractPinnedVersionFor(setupHooksText, tool)
    const toolHits = findToolPins(tool, workflowsDir)
    results[tool] = { pinnedVersion, toolHits }
    problems.push(...checkToolConsistency(tool, { pinnedVersion, toolHits }))
  }
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-prek-version-pin.mjs found ${problems.length} pin-consistency problem(s) (#3742):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return results
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const results = assertPrekVersionPinConsistency()
  const summary = TRACKED_TOOLS.map((t) => `${t}=${results[t].pinnedVersion}`).join(', ')
  const totalSites = TRACKED_TOOLS.reduce((n, t) => n + results[t].toolHits.length, 0)
  console.log(
    `OK  prek/taplo-cli/typos-cli version pins: ${summary} (${TRACKED_TOOLS.length} tool(s), ` +
      `${totalSites} tool: list site(s) checked, all agree with setup-hooks.sh)`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

function selfTestExtraction({ check }) {
  const fixture =
    'pinned_version_for() {\n' +
    '  case "$1" in\n' +
    '    sqruff) echo "0.38.0" ;;\n' +
    '    prek) echo "0.3.8" ;;\n' +
    '    taplo-cli) echo "0.10.0" ;;\n' +
    '    typos-cli) echo "1.46.0" ;;\n' +
    '    *) echo "" ;;\n' +
    '  esac\n' +
    '}\n'
  check(
    extractPinnedVersionFor(fixture, 'prek') === '0.3.8',
    'prek pin extracted verbatim from the case arm',
    extractPinnedVersionFor(fixture, 'prek'),
  )
  check(
    extractPinnedVersionFor(fixture, 'taplo-cli') === '0.10.0',
    'taplo-cli pin extracted from a hyphenated crate name',
    extractPinnedVersionFor(fixture, 'taplo-cli'),
  )
  check(
    extractPinnedVersionFor(fixture, 'typos-cli') === '1.46.0',
    'typos-cli pin extracted correctly',
    extractPinnedVersionFor(fixture, 'typos-cli'),
  )
  check(
    extractPinnedVersionFor(fixture, 'cargo-nextest') === null,
    'a tool with no arm at all extracts as null (unpinned), not a false match',
    String(extractPinnedVersionFor(fixture, 'cargo-nextest')),
  )
  check(
    extractPinnedVersionFor(
      'pinned_version_for() {\n  case "$1" in\n    prek) echo "" ;;\n    *) echo "" ;;\n  esac\n}\n',
      'prek',
    ) === null,
    'an explicitly EMPTY pin reads the same as unpinned, not as version ""',
    '',
  )

  check(
    parseToolFromToolLine('        tool: prek,zizmor,taplo-cli', 'prek')?.version === null,
    'a bare prek entry parses as version: null',
    JSON.stringify(parseToolFromToolLine('        tool: prek,zizmor,taplo-cli', 'prek')),
  )
  check(
    parseToolFromToolLine('        tool: prek@0.3.8,zizmor@1.28.0,taplo-cli@0.10.0', 'prek')
      ?.version === '0.3.8',
    'a pinned prek entry parses its version',
    JSON.stringify(
      parseToolFromToolLine('        tool: prek@0.3.8,zizmor@1.28.0,taplo-cli@0.10.0', 'prek'),
    ),
  )
  check(
    parseToolFromToolLine('        tool: prek@0.3.8,zizmor@1.28.0,taplo-cli@0.10.0', 'taplo-cli')
      ?.version === '0.10.0',
    'a HYPHENATED tool name (taplo-cli) is not truncated at the hyphen',
    JSON.stringify(
      parseToolFromToolLine('        tool: prek@0.3.8,zizmor@1.28.0,taplo-cli@0.10.0', 'taplo-cli'),
    ),
  )
  check(
    parseToolFromToolLine('        tool: sqruff@0.38.0', 'prek') === undefined,
    'a tool: line with no entry for the requested tool returns undefined, not a false positive',
    JSON.stringify(parseToolFromToolLine('        tool: sqruff@0.38.0', 'prek')),
  )
  // The bug class one level down from itself: a tool NAMED e.g.
  // "not-prek-cli" must not satisfy a substring match for "prek".
  check(
    parseToolFromToolLine('        tool: not-prek-cli', 'prek') === undefined,
    'a tool name that merely CONTAINS the target as a substring is not a match',
    JSON.stringify(parseToolFromToolLine('        tool: not-prek-cli', 'prek')),
  )
  check(
    parseToolFromToolLine('        tool: prek@0.3.8  # pinned, see #3742', 'prek')?.version ===
      '0.3.8',
    'a trailing comment after the entry does not swallow the pin',
    JSON.stringify(parseToolFromToolLine('        tool: prek@0.3.8  # pinned, see #3742', 'prek')),
  )
  let threw = null
  try {
    parseToolFromToolLine('        tool: |', 'prek')
  } catch (err) {
    threw = err
  }
  check(
    threw !== null && /block scalar/.test(threw.message),
    'a YAML block-scalar tool: value fails loud instead of silently reading as no entry',
    threw ? threw.message : '(no throw)',
  )
}

function selfTestConsistency({ check }) {
  check(
    checkToolConsistency('prek', {
      pinnedVersion: '0.3.8',
      toolHits: [
        { location: 'a.yml:1', version: '0.3.8' },
        { location: 'b.yml:1', version: '0.3.8' },
      ],
    }).length === 0,
    'consistently pinned to the same version everywhere passes',
    '',
  )
  check(
    checkToolConsistency('prek', { pinnedVersion: '0.3.8', toolHits: [] }).length === 1,
    'zero tool: sites found at all is a FAILURE (wiring guard), not a vacuous pass',
    '',
  )
  check(
    checkToolConsistency('prek', {
      pinnedVersion: null,
      toolHits: [
        { location: 'a.yml:1', version: null },
        { location: 'b.yml:1', version: null },
      ],
    }).length === 1,
    'unlike zizmor, unpinned-everywhere for one of these three tools is STILL a failure (see header)',
    '',
  )
  {
    const problems = checkToolConsistency('prek', {
      pinnedVersion: '0.3.8',
      toolHits: [
        { location: 'a.yml:1', version: '0.3.8' },
        { location: 'b.yml:1', version: null }, // one site never got the pin
      ],
    })
    check(
      problems.length === 1 && problems[0].includes('b.yml:1'),
      'one tool: site left unpinned while setup-hooks.sh is pinned is caught',
      JSON.stringify(problems),
    )
  }
  {
    const problems = checkToolConsistency('prek', {
      pinnedVersion: '0.3.8',
      toolHits: [{ location: 'a.yml:1', version: '0.4.11' }], // CI floated ahead
    })
    check(
      problems.length === 1 && problems[0].includes('0.4.11') && problems[0].includes('0.3.8'),
      'the EXACT #3742 shape — CI pinned to a newer version than setup-hooks.sh installs locally — is caught',
      JSON.stringify(problems),
    )
  }
}

function selfTestDiskScan({ check }) {
  const dir = mkdtempSync(join(tmpdir(), 'prek-pin-scan-'))
  writeFileSync(
    join(dir, 'x.yml'),
    ['name: X', '          tool: prek@0.3.8,taplo-cli@0.10.0,sqruff@0.38.0', ''].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(dir, 'y.yaml'),
    ['name: Y', '          tool: prek,typos-cli@1.46.0', ''].join('\n'),
    'utf8',
  )
  writeFileSync(join(dir, 'not-a-workflow.txt'), 'tool: prek@9.9.9\n', 'utf8')

  const prekHits = findToolPins('prek', dir)
  check(
    prekHits.length === 2,
    'the scan finds exactly the prek entries in .yml/.yaml files, ignoring non-workflow files',
    JSON.stringify(prekHits),
  )
  check(
    prekHits.some((h) => h.location === 'x.yml:2' && h.version === '0.3.8'),
    'a pinned prek hit records the correct file:line and version',
    JSON.stringify(prekHits),
  )
  check(
    prekHits.some((h) => h.location === 'y.yaml:2' && h.version === null),
    'a bare prek hit records version: null with the correct file:line',
    JSON.stringify(prekHits),
  )

  const taploHits = findToolPins('taplo-cli', dir)
  check(
    taploHits.length === 1 && taploHits[0].version === '0.10.0',
    'a hyphenated tool name (taplo-cli) is found by the real file scan too',
    JSON.stringify(taploHits),
  )

  const typosHits = findToolPins('typos-cli', dir)
  check(
    typosHits.length === 1 &&
      typosHits[0].location === 'y.yaml:2' &&
      typosHits[0].version === '1.46.0',
    'typos-cli sharing a tool: line with a bare prek entry is still found correctly',
    JSON.stringify(typosHits),
  )
}

function selfTestEndToEnd({ check, fail }) {
  const dir = mkdtempSync(join(tmpdir(), 'prek-pin-e2e-'))
  const setupHooksPath = join(dir, 'setup-hooks.sh')
  const workflowsDir = join(dir, 'workflows')
  mkdirSync(workflowsDir, { recursive: true })

  writeFileSync(
    setupHooksPath,
    'pinned_version_for() {\n  case "$1" in\n    prek) echo "0.3.8" ;;\n    taplo-cli) echo "0.10.0" ;;\n    typos-cli) echo "1.46.0" ;;\n    *) echo "" ;;\n  esac\n}\n',
    'utf8',
  )
  writeFileSync(
    join(workflowsDir, 'a.yml'),
    '          tool: prek@0.3.8,taplo-cli@0.10.0,typos-cli@1.46.0\n',
    'utf8',
  )
  let threw = null
  try {
    assertPrekVersionPinConsistency({ setupHooksPath, workflowsDir })
  } catch (err) {
    threw = err
  }
  check(threw === null, 'end-to-end: a fully consistent fixture does not throw', threw?.message)

  writeFileSync(
    join(workflowsDir, 'b.yml'),
    '          tool: prek@0.4.11,typos-cli@1.46.0\n',
    'utf8',
  )
  threw = null
  try {
    assertPrekVersionPinConsistency({ setupHooksPath, workflowsDir })
  } catch (err) {
    threw = err
  }
  check(
    threw !== null && threw.message.includes('b.yml') && threw.message.includes('0.4.11'),
    'end-to-end: introducing a drifted fixture (a newer prek in one workflow) DOES throw, and names the offending site',
    threw?.message ?? '(no throw)',
  )

  // …and the real repo, as it stands right now, must itself be consistent.
  try {
    const results = assertPrekVersionPinConsistency()
    check(
      true,
      `the real repo's prek/taplo-cli/typos-cli pins are consistent (${TRACKED_TOOLS.map((t) => `${t}=${results[t].pinnedVersion}`).join(', ')})`,
      '',
    )
  } catch (err) {
    fail("the real repo's prek/taplo-cli/typos-cli pins are consistent", err.message)
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
      console.error(`check-prek-version-pin: ${err.message}`)
      process.exit(1)
    }
  }
}
