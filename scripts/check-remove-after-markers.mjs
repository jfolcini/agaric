#!/usr/bin/env node
// #4129 accuracy guard — fail a commit that reaches or passes the version
// named by a `REMOVE AFTER <x.y.z>` marker still sitting in tracked source.
//
// ─── The incident ──────────────────────────────────────────────────────
//
// `migrate_personal_pages_to_work` carried a doc comment that named its own
// kill-date: "REMOVE AFTER `0.3.0`. Removal trigger: when `0.3.0` is cut,
// delete the function and its helpers in the same commit that bumps the
// version." The plan was clear, correct, and self-describing. It still
// failed: the repo reached 0.9.8 — six minor versions and roughly four
// months later — with the migration still exported, still reachable, still
// running an extra query on every cold boot. It was removed only because a
// deep review happened to read the doc comment. The containment mechanism
// was "a human remembers at release time", and it failed silently — see
// #3282 finding 2.
//
// ─── Canonical "current version" — src-tauri/tauri.conf.json ────────────
//
// The repo carries FIVE version manifests
// (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
// `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) that
// `verify-version-agreement` (`.github/workflows/_validate.yml`) already
// keeps in mutual lockstep on every PR/push. This guard still has to pick
// ONE to read `CURRENT_VERSION` from, and picks `src-tauri/tauri.conf.json`:
//   - it is the Tauri application manifest — the version the SHIPPED app
//     itself reports (window title / About surface, the updater's own
//     version check) — which is the exact question a "REMOVE AFTER" marker
//     is asking: has a RUNNING INSTANCE of the app reached this version.
//     `package.json` / `Cargo.toml` are build-tooling manifests one hop
//     further from that question;
//   - `verify-version-agreement`'s own comparison already treats it as the
//     pivot value (`CONF`) every other manifest is checked against
//     (`.github/workflows/_validate.yml`'s `verify-version-agreement` job):
//     `for v in "$CARGO" "$CARGO_LOCK" "$PKG" "$PKG_LOCK"; do if [ "$v" !=
//     "$CONF" ]`. Reusing that pivot keeps this guard's notion of "current"
//     answering the same question the existing mutual-agreement check does.
// Since the five manifests are already enforced to agree, which one is read
// matters only for defining the rule precisely — not for correctness day to
// day; tauri.conf.json is the one with a real semantic tie to "has this
// version shipped".
//
// ─── Canonical marker spelling ───────────────────────────────────────────
//
// Exactly `REMOVE AFTER <x.y.z>` (all-caps, that literal phrase, a semver
// TRIPLE — no `v` prefix, no pre-release suffix, no extra `.w` component),
// optionally wrapped in markdown backticks, as the original comment used
// it. Markdown BOLD (`**1.2.3**`) is NOT a canonical wrapping — a bold
// marker is reported malformed, same as any other near-miss. The regex
// below is deliberately narrow: mechanical findability was the whole
// design goal (#4129's own text — "the value is in the marker being
// mechanically findable, so the format has to be fixed, not prose"), so a
// line that says "REMOVE AFTER" but does not carry a well-formed triple is
// its own failure — a near-miss marker that silently guards nothing is
// worse than no marker, and this guard refuses to let one pass quietly.
//
// ─── Where it runs — no `.github/workflows/` change needed ──────────────
//
// #4129 asks: pre-commit-only would not have caught the real incident,
// because the version bump and the marker lived in DIFFERENT commits — a
// hook gated on "did a file matching X change in THIS commit" never fires
// on a bump-version commit that only touches the 5 manifests. The fix is
// not a new CI job: it is including THOSE FIVE MANIFESTS in this hook's own
// `files` trigger (see `prek.toml`), so a commit that bumps the version — a
// `bump-version.sh` commit touches exactly those five — also re-scans the
// WHOLE tracked tree for markers (`pass_filenames = false`), independent of
// which files that particular commit touched. And for the case where a
// commit skips hooks entirely (`--no-verify`), the existing CI backstop
// already covers it without any change here: the `lint` job runs
// `prek run --all-files` (`.github/workflows/_validate.yml:711`)
// unconditionally whenever the push is not docs-only — and a version bump
// never is.
//
// ─── The escape hatch ────────────────────────────────────────────────────
//
// Bump the marker itself. There is deliberately no CLI opt-out flag: "yes,
// deliberately keeping this one more release" is a one-line, reviewable
// edit to the marker's own version, exactly as visible in the diff as
// forgetting would be invisible in its absence (#4129's own framing).
//
// Heuristic:
//   - Scan every tracked `*.rs`, `*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.py`,
//     `*.sh`, `*.md` file (this script's own path excluded) for a line
//     containing the literal substring `REMOVE AFTER`. `*.js`/`*.mjs` are
//     in scope so a marker left in a GUARD SCRIPT — `scripts/` itself — is
//     as findable as one left in application source; the exclusion of
//     THIS file's own path (see `SELF_PATH` below) is what keeps that from
//     self-triggering on this header's own prose examples and the
//     self-test fixtures' string literals below.
//   - A line matching the canonical spelling records a marker; the CURRENT
//     version is compared against it with NUMERIC per-component semver
//     comparison (major, then minor, then patch, each as an integer —
//     never a string compare, which gets `0.10.0` vs `0.9.8` backwards).
//     Fail when `CURRENT >= MARKER`.
//   - A line containing the substring but not matching the canonical
//     spelling is a MALFORMED marker — also a failure, named separately.
//   - `docs/session-log/**` is excluded: a historical session recounting a
//     marker that has since been resolved is an archive, not a live one.
//   - Each file (including the version manifest itself) is read from the
//     copy the caller is actually judging — the STAGED INDEX during a
//     commit, the WORKING TREE otherwise (#3962). `--cached` / `--worktree`
//     force it; with neither, `GIT_INDEX_FILE` decides. Rationale:
//     scripts/lib/guard-file-source.mjs.
//
// Usage:
//   node scripts/check-remove-after-markers.mjs              # auto source
//   node scripts/check-remove-after-markers.mjs --cached     # staged index
//   node scripts/check-remove-after-markers.mjs --worktree   # working tree
//   node scripts/check-remove-after-markers.mjs --print-source
//   node scripts/check-remove-after-markers.mjs --self-test
//
// Any OTHER argument is a usage error, not a silently ignored one.
//
// Exit codes: 0 clean / 1 an expired or malformed marker / 2 invocation error.

import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  initScratchRepo,
  scrubbedGitEnv,
  withScrubbedProcessEnv,
} from './lib/git-scratch-guard.mjs'
import {
  describeSource,
  gitEnv,
  listTrackedEntries,
  readContents,
  resolveSource,
} from './lib/guard-file-source.mjs'

// cwd-derived, not script-anchored — the documented EXCEPTION to "a guard
// judges the tree that contains it" (see `scripts/lib/guard-file-source.mjs`,
// "Which TREE is judged, and the one documented exception").
const REPO_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
})()

const GIT_ENV = gitEnv(REPO_ROOT, process.env)

// This file's own repo-relative path — excluded from the marker scan
// because `SCAN_EXT_RE` below includes `.mjs`, and this file's own text
// carries plenty of `REMOVE AFTER` occurrences that are not live markers:
// the incident recap in the header (a canonical `` `0.3.0` `` triple, used
// as a WORKED EXAMPLE), and the self-test fixtures further down, whose
// string literals write canonical-looking and malformed-looking markers
// (`0.1.0`, `9.9.9`, `0.10.0`, `1.2.3-beta`, …) into THIS source file even
// though they are only ever materialised into throwaway scratch repos.
// Without this exclusion this script would self-trigger.
const SELF_PATH = 'scripts/check-remove-after-markers.mjs'

// The canonical "current version" manifest — see the header's rationale.
const VERSION_MANIFEST = 'src-tauri/tauri.conf.json'

// Historical archive, same exemption the citation guards use.
const EXCLUDE_PATH_RE = /^docs\/session-log\//

const SCAN_EXT_RE = /\.(rs|ts|tsx|js|mjs|py|sh|md)$/

// The literal phrase, checked FIRST and cheaply per line before the
// stricter parse below — this is what lets a near-miss (right phrase,
// malformed version) be told apart from "no marker on this line at all".
const MARKER_PHRASE_RE = /REMOVE AFTER/
// Canonical spelling: the phrase, whitespace, an optional opening
// backtick, a semver TRIPLE, an optional closing backtick. No `v` prefix,
// no pre-release suffix — `#4129`'s own text pins the format to keep it
// mechanically findable. The trailing negative lookahead END-ANCHORS the
// triple: it refuses to match when the digits are immediately followed by
// `-` (a pre-release suffix, `1.2.3-beta`) or `.<digit>` (a fourth
// component, `1.2.3.4`) — without it those forms would silently match on
// their `1.2.3` PREFIX and be recorded as well-formed with the remainder
// dropped, rather than reported as the malformed near-misses they are.
//
// The lookahead's first branch is `[\d-]`, NOT a bare `-`: `(\d+)` is
// GREEDY, and a bare `-` lookahead is defeated by backtracking whenever the
// patch component has two or more digits. On `1.2.34-beta`, `(\d+)` first
// takes `34`; the lookahead sees `-` and fails; the engine backtracks the
// capture to `3`; the next character is `4` — neither `-` nor `.<digit>` —
// so the (now too-narrow) lookahead passes, and the marker is silently
// recorded as the well-formed `1.2.3`, with `4-beta` dropped. Excluding any
// trailing DIGIT too (not just `-`) closes that: backtracking to any
// shorter prefix still leaves a digit immediately after, which the
// lookahead now also rejects. Same shape turns `1.0.12.4` into `1.0.1`.
const MARKER_STRICT_RE = /REMOVE AFTER\s+`?(\d+)\.(\d+)\.(\d+)(?![\d-]|\.\d)`?/

function scanTargets(tracked) {
  return tracked.filter((f) => {
    if (f === SELF_PATH) return false
    if (EXCLUDE_PATH_RE.test(f)) return false
    return SCAN_EXT_RE.test(f)
  })
}

/** `[major, minor, patch]` as integers, or `null` if `v` isn't `\d+\.\d+\.\d+`. */
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Numeric per-component comparison — NEVER a string compare (`"0.10.0" <
 * "0.9.8"` lexically, which is backwards: 10 > 9). Returns <0 / 0 / >0. */
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * Walk every target's lines for `REMOVE AFTER`. Returns
 * `{ markers, malformed }`:
 *   - `markers`: `{ file, lineNo, text, version: [maj,min,pat], versionStr }`
 *     for every line matching the CANONICAL spelling;
 *   - `malformed`: `{ file, lineNo, text }` for every line carrying the
 *     phrase but NOT the canonical spelling — a marker nobody can act on
 *     mechanically, which is exactly the failure mode #4129 exists to
 *     prevent, so it is reported rather than silently skipped.
 */
function findMarkers(files, bodies) {
  const markers = []
  const malformed = []
  for (const file of files) {
    const body = bodies.get(file)
    if (body === undefined) continue
    const lines = body.split('\n')
    lines.forEach((line, idx) => {
      if (!MARKER_PHRASE_RE.test(line)) return
      const m = MARKER_STRICT_RE.exec(line)
      if (!m) {
        malformed.push({ file, lineNo: idx + 1, text: line.trim() })
        return
      }
      markers.push({
        file,
        lineNo: idx + 1,
        text: line.trim(),
        version: [Number(m[1]), Number(m[2]), Number(m[3])],
        versionStr: `${m[1]}.${m[2]}.${m[3]}`,
      })
    })
  }
  return { markers, malformed }
}

function check() {
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      extraFlags: ['--print-source', '--self-test'],
      repoRoot: REPO_ROOT,
    })
  } catch (err) {
    process.stderr.write(`check-remove-after-markers: invocation error: ${err.message}\n`)
    return 2
  }
  if (process.argv.includes('--print-source')) {
    console.log(`check-remove-after-markers: ${describeSource(chosen.source)} (${chosen.why})`)
    return 0
  }
  let entries
  try {
    entries = listTrackedEntries(REPO_ROOT, { env: GIT_ENV })
  } catch (err) {
    process.stderr.write(`check-remove-after-markers: invocation error: ${err.message}\n`)
    return 2
  }
  if (entries === null) {
    console.warn('check-remove-after-markers: not a git repo; skipping.')
    return 0
  }
  const tracked = new Set(entries.paths)
  if (!tracked.has(VERSION_MANIFEST)) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: ${VERSION_MANIFEST} is not tracked; cannot read the current version.\n`,
    )
    return 2
  }
  const targets = scanTargets(entries.paths)
  let bodies
  let manifestBody
  try {
    bodies = readContents(targets, {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
    manifestBody = readContents([VERSION_MANIFEST], {
      repoRoot: REPO_ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    }).get(VERSION_MANIFEST)
  } catch (err) {
    process.stderr.write(`check-remove-after-markers: invocation error: ${err.message}\n`)
    return 2
  }
  if (manifestBody === undefined) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: could not read ${VERSION_MANIFEST} from the ${describeSource(chosen.source)}.\n`,
    )
    return 2
  }
  let currentVersionStr
  try {
    const parsed = JSON.parse(manifestBody)
    currentVersionStr = parsed.version
  } catch (err) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: ${VERSION_MANIFEST} is not valid JSON: ${err.message}\n`,
    )
    return 2
  }
  const current = parseSemver(String(currentVersionStr ?? ''))
  if (!current) {
    process.stderr.write(
      `check-remove-after-markers: invocation error: ${VERSION_MANIFEST}'s "version" (${JSON.stringify(currentVersionStr)}) is not a plain X.Y.Z semver triple.\n`,
    )
    return 2
  }

  const { markers, malformed } = findMarkers(targets, bodies)
  const expired = markers.filter((mk) => compareSemver(current, mk.version) >= 0)

  if (expired.length === 0 && malformed.length === 0) {
    return 0
  }
  process.stderr.write(
    `  (judged the ${describeSource(chosen.source)} — ${chosen.why}; current version ${current.join('.')} from ${VERSION_MANIFEST})\n`,
  )
  if (expired.length > 0) {
    process.stderr.write(
      'ERROR: a REMOVE AFTER marker has reached or passed the current version:\n',
    )
    for (const mk of expired) {
      process.stderr.write(
        `  - ${mk.file}:${mk.lineNo}: marker ${mk.versionStr}, current ${current.join('.')} — ${mk.text}\n`,
      )
    }
    process.stderr.write(
      '\nFix: delete the code the marker guards, or — if it must live one more release —\n' +
        'bump the marker to a version past the current one (a visible, reviewable choice).\n',
    )
  }
  if (malformed.length > 0) {
    process.stderr.write(
      'ERROR: a line names "REMOVE AFTER" but not in the canonical `REMOVE AFTER x.y.z` form:\n',
    )
    for (const mk of malformed) {
      process.stderr.write(`  - ${mk.file}:${mk.lineNo}: ${mk.text}\n`)
    }
    process.stderr.write('\nFix: spell it exactly `REMOVE AFTER x.y.z` (a plain semver triple).\n')
  }
  return 1
}

// ─── self-test ────────────────────────────────────────────────────────

function tauriConf(version) {
  return `${JSON.stringify({ version, productName: 'fixture' }, null, 2)}\n`
}

function run(dir, env, flags) {
  const r = spawnSync(process.execPath, [import.meta.filename, ...flags], {
    cwd: dir,
    env,
    encoding: 'utf8',
  })
  return { status: r.status, stderr: r.stderr ?? '' }
}

/**
 * #4129's own acceptance test: a fixture carrying `REMOVE AFTER 0.1.0`
 * while the manifest is at a later version fails and NAMES BOTH versions;
 * bumping the fixture's marker past the manifest clears it.
 */
function expiryScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'expiry')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('1.5.0'))
    mkdirSync(join(dir, 'src-tauri', 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src-tauri', 'src', 'migration.rs'),
      '// REMOVE AFTER 0.1.0. Delete this migration once cut.\nfn migrate() {}\n',
    )
    git('add', '-A')
    const expired = run(dir, env, ['--worktree'])
    record(
      'a marker whose version the manifest has already passed is red, naming both versions',
      expired.status === 1 &&
        /0\.1\.0/.test(expired.stderr) &&
        /1\.5\.0/.test(expired.stderr) &&
        /migration\.rs/.test(expired.stderr),
      `expected 1 naming 0.1.0 + 1.5.0 + migration.rs, got ${expired.status}: ${expired.stderr}`,
    )

    // Falsification's second half: bump the marker PAST the manifest — the
    // same fixture, same file, now green.
    writeFileSync(
      join(dir, 'src-tauri', 'src', 'migration.rs'),
      '// REMOVE AFTER 9.9.9. Delete this migration once cut.\nfn migrate() {}\n',
    )
    git('add', '-A')
    const future = run(dir, env, ['--worktree'])
    record(
      'the SAME marker, bumped past the manifest version, is green',
      future.status === 0,
      `expected 0, got ${future.status}: ${future.stderr}`,
    )
    return results
  })
}

/**
 * Numeric-vs-string comparison. Manifest at `0.9.8`, marker at `0.10.0`.
 * `0.10.0` has NOT been reached (10 > 9 in the minor slot) — a STRING
 * comparison gets this backwards (`"0.10.0" < "0.9.8"` lexically, because
 * `'1' < '9'` at the second character), which would wrongly report the
 * marker as expired.
 */
function numericComparisonScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'numeric')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'notes.ts'), '// REMOVE AFTER 0.10.0\nexport const x = 1\n')
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      '0.9.8 has NOT reached 0.10.0 (numeric minor 9 < 10) — a string compare would say otherwise',
      result.status === 0,
      `expected 0 (not yet expired), got ${result.status}: ${result.stderr}`,
    )
    return results
  })
}

/** A line naming the phrase without a well-formed triple is its own failure. */
function malformedScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'malformed')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('1.0.0'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'notes.ts'),
      '// REMOVE AFTER the next major release\nexport const x = 1\n',
    )
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      'REMOVE AFTER without a semver triple is a red, distinct from an expiry',
      result.status === 1 &&
        /not in the canonical/.test(result.stderr) &&
        /notes\.ts/.test(result.stderr),
      `expected 1 naming a malformed marker in notes.ts, got ${result.status}: ${result.stderr}`,
    )
    return results
  })
}

/**
 * The header/regex end-anchoring, both directions. A pre-release suffix
 * (`1.2.3-beta`) and a fourth component (`1.2.3.4`) must NOT silently match
 * on their `1.2.3` prefix — they are near-misses, reported malformed, not
 * accepted with the remainder dropped. Markdown BOLD is not a canonical
 * wrapping (only backticks are) — a bold triple is malformed too, not a
 * near-miss the header fails to document.
 *
 * The two multi-digit-patch cases (`1.2.34-beta`, `1.0.12.4`) exist
 * SEPARATELY from their single-digit siblings above for a reason: a bare
 * `-` / `.` lookahead is defeated by BACKTRACKING once the patch component
 * has two or more digits — `(\d+)` greedily takes `34`, the lookahead
 * fails, the engine backtracks the capture to `3`, and the character now
 * immediately after (`4`) satisfies a too-narrow lookahead, so the marker
 * is silently recorded as well-formed `1.2.3` with the remainder dropped.
 * Single-digit patches (`1.2.3-beta`, `1.2.3.4`) cannot exercise this —
 * there is nothing shorter to backtrack `3` to — which is exactly why they
 * passed against the shipped regex while this defect was live. These two
 * cases are the ones that would have failed.
 */
function nearMissFormScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const cases = [
      ['pre-release', '// REMOVE AFTER 1.2.3-beta\nexport const x = 1\n'],
      ['fourth component', '// REMOVE AFTER 1.2.3.4\nexport const x = 1\n'],
      ['bold wrapping', '// REMOVE AFTER **1.2.3**\nexport const x = 1\n'],
      [
        'pre-release, multi-digit patch (backtracking)',
        '// REMOVE AFTER 1.2.34-beta\nexport const x = 1\n',
      ],
      [
        'fourth component, multi-digit patch (backtracking)',
        '// REMOVE AFTER 1.0.12.4\nexport const x = 1\n',
      ],
    ]
    for (const [label, contents] of cases) {
      const dir = join(root, `near-miss-${label.replace(/\s+/g, '-')}`)
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      mkdirSync(join(dir, 'src-tauri'), { recursive: true })
      writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('1.0.0'))
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'notes.ts'), contents)
      git('add', '-A')
      const result = run(dir, env, ['--worktree'])
      record(
        `${label} does not match the canonical triple — reported malformed, not silently truncated`,
        result.status === 1 &&
          /not in the canonical/.test(result.stderr) &&
          /notes\.ts/.test(result.stderr),
        `expected 1 naming a malformed marker in notes.ts, got ${result.status}: ${result.stderr}`,
      )
    }
    return results
  })
}

/**
 * The two forms that MUST keep matching after the backtracking fix — this
 * is the falsification half of `nearMissFormScenarios` above: tightening
 * the lookahead to also exclude a trailing digit must not, as a side
 * effect, start rejecting well-formed markers it used to accept.
 *   - backtick-wrapped, the original incident's own spelling
 *     (`` REMOVE AFTER `0.9.9` ``);
 *   - the bare prose-sentence form, the exact shape the incident comment
 *     used (`REMOVE AFTER 0.3.0. Removal trigger: …`) — a period directly
 *     after the triple, no backtick, no wrapping at all.
 * Both are given manifests at or past their marker version, so a pass here
 * requires the marker to have been PARSED (not just "not reported
 * malformed") — the expiry report names the exact marker version, which a
 * silently-truncated or unmatched marker could not produce.
 */
function stillMatchesCanonicalScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })

    const backtickDir = join(root, 'still-matches-backtick')
    const backtickEnv = scrubbedGitEnv(root)
    const backtickGit = initScratchRepo(backtickDir, backtickEnv)
    mkdirSync(join(backtickDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(backtickDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.9'))
    mkdirSync(join(backtickDir, 'src'), { recursive: true })
    writeFileSync(
      join(backtickDir, 'src', 'notes.ts'),
      '// REMOVE AFTER `0.9.9`\nexport const x = 1\n',
    )
    backtickGit('add', '-A')
    const backtickResult = run(backtickDir, backtickEnv, ['--worktree'])
    record(
      'backtick-wrapped `REMOVE AFTER `0.9.9`` still matches canonically and is reported expired, not malformed',
      backtickResult.status === 1 &&
        /0\.9\.9/.test(backtickResult.stderr) &&
        !/not in the canonical/.test(backtickResult.stderr),
      `expected 1 naming 0.9.9 without a malformed report, got ${backtickResult.status}: ${backtickResult.stderr}`,
    )

    const sentenceDir = join(root, 'still-matches-sentence')
    const sentenceEnv = scrubbedGitEnv(root)
    const sentenceGit = initScratchRepo(sentenceDir, sentenceEnv)
    mkdirSync(join(sentenceDir, 'src-tauri'), { recursive: true })
    writeFileSync(join(sentenceDir, 'src-tauri', 'tauri.conf.json'), tauriConf('0.9.8'))
    mkdirSync(join(sentenceDir, 'src-tauri', 'src'), { recursive: true })
    writeFileSync(
      join(sentenceDir, 'src-tauri', 'src', 'migration.rs'),
      '// REMOVE AFTER 0.3.0. Removal trigger: when `0.3.0` is cut, delete the\n' +
        '// function and its helpers in the same commit that bumps the version.\n' +
        'fn migrate_personal_pages_to_work() {}\n',
    )
    sentenceGit('add', '-A')
    const sentenceResult = run(sentenceDir, sentenceEnv, ['--worktree'])
    record(
      'bare sentence form `REMOVE AFTER 0.3.0. Removal trigger: …` (the original incident) still matches and is reported expired, not malformed',
      sentenceResult.status === 1 &&
        /0\.3\.0/.test(sentenceResult.stderr) &&
        !/not in the canonical/.test(sentenceResult.stderr),
      `expected 1 naming 0.3.0 without a malformed report, got ${sentenceResult.status}: ${sentenceResult.stderr}`,
    )

    return results
  })
}

/**
 * `SCAN_EXT_RE` covers `.js`/`.mjs` so a marker left in a GUARD SCRIPT is as
 * findable as one in application source — a fixture `.mjs` file under
 * `scripts/` (NOT this guard's own `SELF_PATH`) with an expired marker must
 * be reported, proving the extension is genuinely in scan scope rather than
 * merely claimed in the header.
 */
function scriptExtensionScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'script-extension')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('3.0.0'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(
      join(dir, 'scripts', 'some-other-guard.mjs'),
      '// REMOVE AFTER 0.1.0 — delete this fixture guard once cut.\nconsole.log("guard")\n',
    )
    git('add', '-A')
    const result = run(dir, env, ['--worktree'])
    record(
      'an expired marker inside a `.mjs` script (not this guard itself) is caught, not scan-exempt',
      result.status === 1 &&
        /0\.1\.0/.test(result.stderr) &&
        /some-other-guard\.mjs/.test(result.stderr),
      `expected 1 naming 0.1.0 in some-other-guard.mjs, got ${result.status}: ${result.stderr}`,
    )
    return results
  })
}

/**
 * #3962 — index vs working tree, ONE targeted pair (not the full generic
 * battery — this guard's fixture needs TWO tracked files in lockstep, which
 * the shared single-file `runSourceScenarios` harness does not model): a
 * marker staged as expired, then fixed on disk WITHOUT `git add`. The
 * WORKING TREE reader must see the fix; the INDEX reader must still block
 * the commit that is actually about to land.
 */
function sourceScenarios(root) {
  return withScrubbedProcessEnv(root, () => {
    const results = []
    const record = (name, ok, detail = '') => results.push({ name, ok, detail })
    const dir = join(root, 'source')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, 'src-tauri'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), tauriConf('2.0.0'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'notes.ts'), '// REMOVE AFTER 0.1.0\nexport const x = 1\n')
    git('add', '-A')
    // Fixed on disk, NOT re-staged — the commit still carries the expired
    // marker.
    writeFileSync(join(dir, 'src', 'notes.ts'), '// REMOVE AFTER 9.9.9\nexport const x = 1\n')
    const cached = run(dir, env, ['--cached'])
    const worktree = run(dir, env, ['--worktree'])
    record(
      'the INDEX reader still blocks the commit that actually carries the expired marker',
      cached.status === 1 && /0\.1\.0/.test(cached.stderr),
      `expected 1 naming 0.1.0, got ${cached.status}: ${cached.stderr}`,
    )
    record(
      'the WORKING TREE reader sees the on-disk fix (a different, and valid, question)',
      worktree.status === 0,
      `expected 0, got ${worktree.status}: ${worktree.stderr}`,
    )
    return results
  })
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'remove-after-markers-selftest-'))
  try {
    const results = [
      ...expiryScenarios(root),
      ...numericComparisonScenarios(root),
      ...malformedScenarios(root),
      ...nearMissFormScenarios(root),
      ...stillMatchesCanonicalScenarios(root),
      ...scriptExtensionScenarios(root),
      ...sourceScenarios(root),
    ]
    let failures = 0
    for (const result of results) {
      if (result.ok) {
        console.log(`  ok   - ${result.name}`)
      } else {
        failures += 1
        console.error(`  FAIL - ${result.name}: ${result.detail}`)
      }
    }
    if (failures > 0) {
      console.error('\nself-test FAILED')
      return 1
    }
    console.log('self-test OK')
    return 0
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

process.exit(process.argv.includes('--self-test') ? selfTest() : check())
