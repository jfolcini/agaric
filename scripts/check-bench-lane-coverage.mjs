#!/usr/bin/env node
// #3362 — every criterion bench must be covered by one of the two bench lanes.
//
// `scheduled-deep-checks.yml` runs the bench universe across TWO jobs:
//   bench-smoke  shards and `--test`-smokes every bench EXCEPT the ones the
//                SLO lane warm-runs;
//   bench-slo    warm-runs the SLO gate (`interactive_slo`), which must not be
//                smoke-run in a shard because its budgets need a warm run.
//
// The exclusion used to be a hardcoded `grep -vx interactive_slo` in
// `bench-smoke` with NOTHING asserting `bench-slo` still covered it. Rename the
// bench, rename the job, drift its bench list, and `interactive_slo` falls out
// of BOTH lanes while every shard still exits 0 — from `bench-smoke`'s point of
// view excluding it is correct behaviour. That would silently remove the
// project's only automated latency signal (ARCHITECTURE.md §25 per-operation
// budgets) with everything staying green.
//
// #3330 fixed `bench-smoke`'s own discovery (structural `cargo metadata` +
// a deliberately one-directional block-count cross-check, because
// `autobenches` is on so an auto-discovered bench legitimately exceeds the
// declared `[[bench]]` count). This guard is the level above: it asserts the
// UNION OF LANES covers the universe.
//
// The invariant is enforced in two halves:
//   * DYNAMIC (in the workflow, at run time): both jobs derive their bench
//     list from the single workflow-level `SLO_BENCHES` variable and assert
//     every name in it is a real `cargo metadata` bench target. `bench-smoke`
//     shards `universe \ SLO_BENCHES`, `bench-slo` runs `SLO_BENCHES`, so the
//     union is the universe by construction.
//   * STATIC (this guard, as the `bench-lane-coverage` prek hook): the part
//     the workflow cannot check about itself — that BOTH jobs still exist and
//     still read that variable. Deleting `bench-slo`, or reverting either job
//     to a hardcoded bench name, fails here instead of quietly emptying a lane.
//
// Textual workflow parsing on purpose, like the other workflow guards: the
// repo's scripts carry no YAML dependency and the workflow's layout is uniform. Every
// pattern is anchored, and a mention inside a `#` comment never satisfies a
// reference check — the self-test pins that direction explicitly, because a
// guard satisfied by the comment that explains it is a guard that cannot fail.
//
// Usage:
//   node scripts/check-bench-lane-coverage.mjs
//     [--workflow <path>]        (default .github/workflows/scheduled-deep-checks.yml)
//     [--manifest-dir <dir>]     (default src-tauri — where `cargo metadata` runs)
//     [--benches a,b,c]          (TEST-ONLY: supply the bench universe instead
//                                 of shelling out to cargo)
//     [--self-test]              (run the fixture suite and exit)
//
// Exit codes: 0 clean, 1 violation or error, 2 self-test failure.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'

export const DEFAULT_WORKFLOW = '.github/workflows/scheduled-deep-checks.yml'
export const DEFAULT_MANIFEST_DIR = 'src-tauri'
export const SMOKE_JOB = 'bench-smoke'
export const SLO_JOB = 'bench-slo'
export const ENV_KEY = 'SLO_BENCHES'

// ---------------------------------------------------------------------------
// Workflow parsing (anchored, comment-aware)
// ---------------------------------------------------------------------------

/**
 * Maps each top-level job name to the lines of its block. A job header is
 * exactly two spaces of indent at the top level of `jobs:`; the block runs
 * until the next such header (or EOF).
 */
export function parseJobBlocks(workflowText) {
  const lines = workflowText.split('\n')
  const jobsIdx = lines.indexOf('jobs:')
  if (jobsIdx === -1) throw new Error('no top-level `jobs:` key found in the workflow')
  const headers = []
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i])
    if (m) headers.push({ name: m[1], start: i })
  }
  if (headers.length === 0) throw new Error('no jobs found under `jobs:`')
  const blocks = new Map()
  for (const [i, h] of headers.entries()) {
    const end = i + 1 < headers.length ? headers[i + 1].start : lines.length
    blocks.set(h.name, lines.slice(h.start, end))
  }
  return blocks
}

/**
 * Reads one key out of the workflow's TOP-LEVEL `env:` mapping. Scoped to the
 * top-level block only (a job-level `env:` is indented and never matches
 * `^env:$`), so a job that happens to define the same key cannot masquerade as
 * the shared source of truth.
 */
export function parseTopLevelEnv(workflowText, key) {
  const lines = workflowText.split('\n')
  const envIdx = lines.indexOf('env:')
  if (envIdx === -1) return null
  const pattern = new RegExp(`^ {2}${key}:\\s*(.+?)\\s*$`)
  for (let i = envIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    // A column-0 non-space line ends the top-level `env:` mapping.
    if (/^\S/.test(line)) break
    const m = pattern.exec(line)
    if (m) return m[1].replace(/^['"]|['"]$/g, '')
  }
  return null
}

/**
 * Where a line stops being shell and starts being a message, or -1.
 *
 * `echo` is a message wherever it appears — including behind a redirection
 * (`>&2 echo …`) or an inline `if`, which is how two of the bypasses below
 * got through a line-initial denylist.
 *
 * `printf` is NOT symmetric with it: `printf '%s\n' "${arr[@]}"` is this
 * workflow's standard way of feeding an array to `grep`/`mapfile`, so treating
 * every `printf` as prose would blank real consumption (it initially blanked
 * this file's own `<(printf '%s\n' "${slo_lane[@]}")` fixture). It reads as a
 * message only when it STARTS the command, never inside a process
 * substitution.
 */
function messageCutIndex(line) {
  let cut = line.search(/\becho\b/)
  for (const m of line.matchAll(/\bprintf\b/g)) {
    const before = line.slice(0, m.index).trimEnd()
    // NB: `(` is deliberately NOT a command-initial cue — `<(printf …)` and
    // `$(printf …)` are data contexts, and treating them as messages blanked
    // the very idiom the workflow uses to feed arrays into `grep`.
    const commandInitial =
      before === '' ||
      /[;&|]$/.test(before) ||
      /\b(?:then|do|else)$/.test(before) ||
      /^\d?>&?\d?\S*$/.test(before)
    if (commandInitial && (cut === -1 || m.index < cut)) cut = m.index
  }
  return cut
}
/** A GitHub workflow-command marker — the other way a diagnostic gets built. */
const WORKFLOW_COMMAND = /::(?:error|warning|notice|debug|group|endgroup)::/
/** YAML scalar keys whose value is human prose, not shell. */
const YAML_PROSE_KEY = /^-?\s*(?:name|id|if|description|summary):\s/
/** `NAME=` / `NAME+=`, optionally behind a declaration keyword. */
const ASSIGNMENT = /^\s*(?:export|declare|local|readonly|typeset)?\s*([A-Za-z_][A-Za-z0-9_]*)\+?=/

/**
 * Rewrites a job block so that only text capable of CONSUMING a variable
 * survives; every prose/diagnostic region becomes an empty line (positions are
 * preserved so callers can still index by line).
 *
 * The first version of this guard asked only "is `$KEY` mentioned outside a
 * comment?", and the workflow's own error message ("…after excluding
 * $SLO_BENCHES") satisfied it, so ripping the read out of `bench-smoke` still
 * passed. That was fixed by skipping lines STARTING with `echo`/`printf` — but
 * a denylist of two line-initial tokens is not the same as understanding where
 * a mention cannot be a use, and in review SEVEN ways through it were built,
 * every one of which left the guard green with the read deleted:
 *
 *   1. `cat <<EOF … $SLO_BENCHES … EOF`  — heredoc body, no `echo` in sight
 *   2. `msg="::error::… $SLO_BENCHES"`   — diagnostic assembled into a var
 *   3. `echo "… \` + continuation line   — the mention is on line 2
 *   4. `if …; then echo "$SLO_BENCHES"`  — line does not START with echo
 *   5. `_unused="$SLO_BENCHES"`          — bound to a name nobody reads
 *   6. `>&2 echo "$SLO_BENCHES"`         — redirection first
 *   7. `- name: … excluding $SLO_BENCHES`— a YAML step name, pure prose
 *
 * Cases 1/3/4/6/7 are handled here (heredoc bodies, continuations, prose keys,
 * and cutting at a message token ANYWHERE in the line rather than only at its
 * start), case 2 by cutting at a workflow-command marker, and case 5 by the
 * liveness rule in `consumesEnvVar`.
 *
 * Note the direction of the residual imprecision: the rules only ever DISCARD
 * text, so an unhandled shape makes the guard fire, never go quiet. A future
 * `printf '%s\n' $SLO_BENCHES | …` would be a false positive whose fix — bind
 * the value to a variable first — is what this guard wants anyway.
 */
export function consumingText(jobLines) {
  const out = []
  let heredocTerm = null
  let messageContinues = false
  for (const raw of jobLines) {
    const t = raw.trim()

    // A heredoc BODY is message text. `<<<` is a HERE-STRING — the actual
    // consumption idiom — so it must never be read as a heredoc opener.
    if (heredocTerm !== null) {
      if (t === heredocTerm) heredocTerm = null
      out.push('')
      continue
    }
    if (messageContinues) {
      messageContinues = t.endsWith('\\')
      out.push('')
      continue
    }
    if (t.startsWith('#') || YAML_PROSE_KEY.test(t)) {
      out.push('')
      continue
    }

    const opener = /<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/.exec(
      raw.replaceAll('<<<', '  '),
    )

    let line = raw
    const msg = messageCutIndex(line)
    if (msg !== -1) {
      messageContinues = t.endsWith('\\')
      line = line.slice(0, msg)
    }
    const wf = WORKFLOW_COMMAND.exec(line)
    if (wf) line = line.slice(0, wf.index)

    if (opener) heredocTerm = opener[1] ?? opener[2] ?? opener[3]
    out.push(line)
  }
  return out
}

/**
 * True when the job actually CONSUMES `key` — i.e. expands it (`$KEY`,
 * `${KEY}`, `${{ env.KEY }}`) somewhere that can affect what the job runs.
 *
 * Prose is stripped by `consumingText`; what remains is one further class of
 * non-use, which no amount of text stripping can see: a value bound to a name
 * that is never read again. `_unused="$SLO_BENCHES"` mentions the variable in
 * live shell and still wires up nothing, so an assignment only counts when its
 * target is referenced elsewhere in the job.
 */
export function consumesEnvVar(jobLines, key) {
  const ref = new RegExp(`(\\$\\{?|env\\.)${key}\\b`)
  const text = consumingText(jobLines)
  return text.some((line, idx) => {
    if (!ref.test(line)) return false
    const assigned = ASSIGNMENT.exec(line)?.[1]
    if (!assigned) return true
    const used = new RegExp(`\\b${assigned}\\b`)
    return text.some((other, i) => i !== idx && used.test(other))
  })
}

// ---------------------------------------------------------------------------
// The bench universe
// ---------------------------------------------------------------------------

/** Structural bench-target list for the `agaric` package — cargo parses the manifest, we don't. */
export function benchUniverse(manifestDir) {
  let out
  try {
    out = execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
      cwd: manifestDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(`\`cargo metadata\` failed in ${manifestDir}: ${err.message}`)
  }
  const meta = JSON.parse(out)
  const pkg = (meta.packages ?? []).find((p) => p.name === 'agaric')
  if (!pkg)
    throw new Error(`no \`agaric\` package in \`cargo metadata\` output from ${manifestDir}`)
  return (pkg.targets ?? [])
    .filter((t) => (t.kind ?? []).includes('bench'))
    .map((t) => t.name)
    .toSorted()
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Returns a list of human-readable problems; empty means the lane union covers
 * the bench universe.
 */
export function checkBenchLaneCoverage({
  workflowText,
  universe,
  smokeJob = SMOKE_JOB,
  sloJob = SLO_JOB,
  envKey = ENV_KEY,
}) {
  const problems = []
  const blocks = parseJobBlocks(workflowText)

  for (const job of [smokeJob, sloJob]) {
    if (!blocks.has(job)) {
      problems.push(
        `job \`${job}\` is not defined in the workflow — one of the two bench lanes is gone, so whatever it covered runs in NO lane while the other lane still exits 0 (#3362).`,
      )
    }
  }

  const raw = parseTopLevelEnv(workflowText, envKey)
  if (raw === null) {
    problems.push(
      `no top-level \`${envKey}:\` in the workflow's \`env:\` block — the two bench lanes then have no shared definition of which benches \`${sloJob}\` covers, and \`${smokeJob}\`'s exclusion goes back to being an unchecked hardcoded string (#3362).`,
    )
    return problems
  }
  const sloBenches = raw.split(/\s+/).filter((s) => s.length > 0)
  if (sloBenches.length === 0) {
    problems.push(
      `top-level \`${envKey}\` is empty — \`${sloJob}\` would run no benches at all while \`${smokeJob}\` still treats its list as "covered elsewhere" (#3362).`,
    )
    return problems
  }

  for (const job of [smokeJob, sloJob]) {
    const lines = blocks.get(job)
    if (!lines) continue
    if (!consumesEnvVar(lines, envKey)) {
      problems.push(
        `job \`${job}\` never expands \`$${envKey}\` anywhere that can affect what it runs — its bench list is hardcoded again, so it can drift out of agreement with the other lane and a bench can fall out of both (#3362). Mentions in comments, YAML step names, heredoc bodies, \`echo\`/\`printf\` messages, \`::error::\` strings and assignments to names nothing else reads all NAME the variable without using it, and so do not count. Bind it to a variable the job actually reads, e.g. \`read -r -a slo_lane <<< "\${${envKey}:-}"\`.`,
      )
    }
  }

  const missing = sloBenches.filter((b) => !universe.includes(b))
  if (missing.length > 0) {
    problems.push(
      `${envKey} names ${missing.map((b) => `\`${b}\``).join(', ')}, which ${missing.length === 1 ? 'is not a bench target' : 'are not bench targets'} in \`cargo metadata\` (universe: ${universe.join(', ')}). \`${sloJob}\` would run nothing for ${missing.length === 1 ? 'it' : 'them'} and \`${smokeJob}\` excludes ${missing.length === 1 ? 'it' : 'them'} — so ${missing.length === 1 ? 'it is' : 'they are'} in NEITHER lane (#3362). If a bench was renamed, rename it here too.`,
    )
  }

  if (universe.length === 0) {
    problems.push(
      'the bench universe is EMPTY — `cargo metadata` reported no bench targets for the `agaric` package, so "every bench is covered" would be vacuously true (#3362).',
    )
  }

  return problems
}

/** The shard lane's derived slice, for reporting: universe minus the SLO lane. */
export function shardLane(universe, sloBenches) {
  return universe.filter((b) => !sloBenches.includes(b))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { workflow: DEFAULT_WORKFLOW, manifestDir: DEFAULT_MANIFEST_DIR }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--workflow': {
        args.workflow = argv[++i]
        break
      }
      case '--manifest-dir': {
        args.manifestDir = argv[++i]
        break
      }
      case '--benches': {
        args.benches = argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        break
      }
      case '--self-test': {
        args.selfTest = true
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${argv[i]}`)
      }
    }
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const workflowText = readFileSync(args.workflow, 'utf8')
  const universe = args.benches ?? benchUniverse(args.manifestDir)
  const problems = checkBenchLaneCoverage({ workflowText, universe })
  if (problems.length > 0) {
    console.error(
      'bench lane coverage (#3362): the two bench lanes do not cover the bench universe',
    )
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  const raw = parseTopLevelEnv(workflowText, ENV_KEY) ?? ''
  const sloBenches = raw.split(/\s+/).filter((s) => s.length > 0)
  console.log(
    `bench lane coverage OK: ${universe.length} bench target(s); ${SLO_JOB} runs ${sloBenches.join(', ')}; ${SMOKE_JOB} shards ${shardLane(universe, sloBenches).join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Every assertion below is paired: a fixture where the guard MUST fire and,
// for the same rule, the healthy fixture where it must stay silent. A guard
// that only ever passes is exactly the failure mode #3362 is about.

const HEALTHY = `name: x

permissions:
  contents: read

env:
  CARGO_TERM_COLOR: always
  SLO_BENCHES: interactive_slo

jobs:
  bench-smoke:
    steps:
      - name: compile
        run: |
          read -r -a slo_lane <<< "$SLO_BENCHES"

  bench-slo:
    steps:
      - name: run
        run: |
          read -r -a slo_lane <<< "$SLO_BENCHES"

  other-lane:
    steps:
      - run: echo hi
`

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const universe = ['agenda_bench', 'core_bench', 'interactive_slo', 'io_bench']

  const expectClean = (name, workflowText, u = universe) => {
    const problems = checkBenchLaneCoverage({ workflowText, universe: u })
    if (problems.length === 0) ok(name)
    else fail(name, problems.join(' | '))
  }
  const expectProblem = (name, workflowText, pattern, u = universe) => {
    const problems = checkBenchLaneCoverage({ workflowText, universe: u })
    if (problems.some((p) => pattern.test(p))) ok(name)
    else fail(name, problems.length === 0 ? 'no problems reported' : problems.join(' | '))
  }

  // 1. The healthy shape is silent — otherwise every check below is noise.
  expectClean('a healthy workflow reports no problems', HEALTHY)

  // 2. The literal #3362 scenario: the bench is renamed in Cargo.toml (so it
  //    leaves the universe under its old name) but SLO_BENCHES still names the
  //    old one. bench-smoke excludes the stale name and shards the new one…
  //    which is exactly what makes this silent without the guard.
  expectProblem(
    'a bench renamed out from under SLO_BENCHES is caught (#3362)',
    HEALTHY,
    /is not a bench target/,
    ['agenda_bench', 'core_bench', 'interactive_slo_v2', 'io_bench'],
  )

  // 3. `bench-slo` deleted outright — the other half of the issue.
  expectProblem(
    'deleting the bench-slo job is caught',
    HEALTHY.replace(/ {2}bench-slo:\n(.|\n)*?\n\n/, ''),
    /job `bench-slo` is not defined/,
  )

  // 4. Reverting a lane to a hardcoded bench name (no $SLO_BENCHES read).
  expectProblem(
    'a hardcoded exclusion in bench-smoke is caught',
    HEALTHY.replace(
      '      - name: compile\n        run: |\n          read -r -a slo_lane <<< "$SLO_BENCHES"',
      '      - name: compile\n        run: |\n          grep -vx interactive_slo',
    ),
    /job `bench-smoke` never expands/,
  )

  // 5. …and the two ways rule 4 would otherwise be vacuous. A lane that merely
  //    MENTIONS SLO_BENCHES — in the prose explaining the wiring, or in the
  //    error message it prints when the wiring fails — has not wired anything.
  //    Case (b) below is not hypothetical: it is how the first version of this
  //    guard passed on a real workflow whose read had been ripped out.
  expectProblem(
    'a lane that only mentions SLO_BENCHES in a comment does not count',
    HEALTHY.replace(
      '          read -r -a slo_lane <<< "$SLO_BENCHES"\n\n  bench-slo:',
      '          # derived from $SLO_BENCHES, honest\n          grep -vx interactive_slo\n\n  bench-slo:',
    ),
    /job `bench-smoke` never expands/,
  )
  expectProblem(
    'a lane that only names SLO_BENCHES in an error message does not count',
    HEALTHY.replace(
      '          read -r -a slo_lane <<< "$SLO_BENCHES"\n\n  bench-slo:',
      '          slo_lane=(interactive_slo)\n          echo "excluding $SLO_BENCHES"\n\n  bench-slo:',
    ),
    /job `bench-smoke` never expands/,
  )

  // 5b. …and the SEVEN further ways past an `echo`/`printf`-prefix denylist,
  //     every one of which left the first hardened version of this guard green
  //     on a `bench-smoke` whose `$SLO_BENCHES` read had been replaced by a
  //     hardcoded array. Each fixture is that exact mutation plus one way of
  //     leaving the NAME behind; all seven must still be caught.
  const hardcoded = '          slo_lane=(interactive_slo)\n'
  const withMention = (mention) =>
    HEALTHY.replace(
      '          read -r -a slo_lane <<< "$SLO_BENCHES"\n\n  bench-slo:',
      `${hardcoded}${mention}\n  bench-slo:`,
    )
  for (const [label, mention] of [
    ['a heredoc body', '          cat <<EOF\n          excluding $SLO_BENCHES\n          EOF\n'],
    ['a diagnostic assembled into a variable', '          msg="::error::excluding $SLO_BENCHES"\n'],
    ['the continuation line of an echo', '          echo "excluding \\\n          $SLO_BENCHES"\n'],
    [
      'an echo behind an inline `if`',
      '          if false; then echo "excluding $SLO_BENCHES"; fi\n',
    ],
    ['a dead assignment nobody reads', '          _unused_doc="$SLO_BENCHES"\n'],
    ['an echo behind a redirection', '          >&2 echo "excluding $SLO_BENCHES"\n'],
  ]) {
    expectProblem(
      `${label} does not count as consuming SLO_BENCHES`,
      withMention(mention),
      /job `bench-smoke` never expands/,
    )
  }
  expectProblem(
    'a YAML step name does not count as consuming SLO_BENCHES',
    withMention('').replace(
      '      - name: compile',
      '      - name: compile, excluding $SLO_BENCHES',
    ),
    /job `bench-smoke` never expands/,
  )

  // 5c. The negatives for 5b: the liveness rule must not reject a LIVE
  //     assignment, and a herestring must not be mistaken for a heredoc
  //     opener — either mistake would make the guard fire on healthy wiring,
  //     and a guard that goes red when nothing is wrong gets disabled.
  // Note "read again" means read by something that can affect what the job
  // RUNS: a name whose only other mention is inside an `echo` is stripped
  // along with that echo and stays dead, which is the correct reading —
  // `slo_lane=($SLO_BENCHES); echo "${slo_lane[*]}"` wires up exactly nothing.
  expectClean(
    'an assignment whose target IS read counts as consuming',
    HEALTHY.replace(
      '          read -r -a slo_lane <<< "$SLO_BENCHES"\n\n  bench-slo:',
      '          slo_lane=($SLO_BENCHES)\n          grep -vxF -f <(printf \'%s\\n\' "${slo_lane[@]}") targets.txt\n\n  bench-slo:',
    ),
  )
  expectClean(
    'a here-string read is not swallowed as a heredoc body',
    HEALTHY.replace(
      '  bench-slo:\n    steps:\n      - name: run\n        run: |\n          read -r -a slo_lane <<< "$SLO_BENCHES"',
      '  bench-slo:\n    steps:\n      - name: run\n        run: |\n          cat <<EOF\n          a banner mentioning nothing\n          EOF\n          read -r -a slo_lane <<< "$SLO_BENCHES"\n          echo "${slo_lane[*]}"',
    ),
  )

  // 6. The shared definition removed / emptied.
  expectProblem(
    'a missing top-level SLO_BENCHES is caught',
    HEALTHY.replace('  SLO_BENCHES: interactive_slo\n', ''),
    /no top-level `SLO_BENCHES:`/,
  )
  expectProblem(
    'an empty SLO_BENCHES is caught',
    HEALTHY.replace('  SLO_BENCHES: interactive_slo', '  SLO_BENCHES: ""'),
    /is empty/,
  )

  // 7. A job-level `env:` must not satisfy the top-level lookup — otherwise
  //    one lane could define its own list and the two would drift apart.
  expectProblem(
    'a job-level SLO_BENCHES does not stand in for the shared top-level one',
    HEALTHY.replace(
      'env:\n  CARGO_TERM_COLOR: always\n  SLO_BENCHES: interactive_slo\n',
      '',
    ).replace('  bench-slo:\n', '  bench-slo:\n    env:\n      SLO_BENCHES: interactive_slo\n'),
    /no top-level `SLO_BENCHES:`/,
  )

  // 8. An empty universe must not read as "everything is covered".
  expectProblem(
    'an empty bench universe is not vacuously covered',
    HEALTHY,
    /bench universe is EMPTY/,
    [],
  )

  // 9. Multi-bench SLO lanes are supported (the list is space-separated), so
  //    the guard does not force a future second warm-run bench back into a
  //    hardcoded string.
  expectClean(
    'a two-bench SLO lane is accepted',
    HEALTHY.replace('SLO_BENCHES: interactive_slo', 'SLO_BENCHES: interactive_slo io_bench'),
  )

  // 10. The real repo files, checked for real. This is the assertion that
  //     actually protects `interactive_slo`; the fixtures above only prove the
  //     rules can fire.
  try {
    const workflowText = readFileSync(DEFAULT_WORKFLOW, 'utf8')
    const real = benchUniverse(DEFAULT_MANIFEST_DIR)
    const problems = checkBenchLaneCoverage({ workflowText, universe: real })
    if (problems.length === 0) ok(`the real workflow covers all ${real.length} real bench targets`)
    else fail('the real workflow covers all real bench targets', problems.join(' | '))
  } catch (err) {
    fail('the real workflow covers all real bench targets', err.message)
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`check-bench-lane-coverage: ${err.message}`)
      process.exit(1)
    }
  }
}
