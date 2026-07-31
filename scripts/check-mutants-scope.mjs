#!/usr/bin/env node
// #3386 — drift guard for the Rust `mutants` lane's scope and plumbing.
//
// The Rust mutation lane produced ZERO coverage for its entire life and
// nobody knew, because every one of its failure modes is silent:
//
//   1. cargo-mutants reads its config from EXACTLY ONE path,
//      `<workspace-root>/.cargo/mutants.toml` (`Config::read_tree_config` in
//      sourcefrog/cargo-mutants `src/config.rs`). If the file is not there it
//      logs "No config found in workspace" at DEBUG level and proceeds with
//      `Config::default()`. The repo kept it at `src-tauri/mutants.toml` from
//      #866 until #3386 — so `examine_globs`, `exclude_globs` and
//      `test_tool = "nextest"` were all inert, the lane mutated the whole
//      `agaric` crate, and the baseline ran `cargo test` (which fails on 5
//      tests that pass under nextest) → `total_mutants: 0`.
//
//   2. A glob can resolve to files in a package the lane never examines.
//      cargo-mutants only generates mutants in the packages it is told to
//      mutate; this workspace's root manifest is itself the `agaric` package
//      with no `default-members`, so a bare `cargo mutants` examines ONLY
//      `agaric`. When the #2621 arch waves moved `op.rs`, `op_log/` and
//      `loro/engine/` into `agaric-store` / `agaric-engine`, the globs were
//      dutifully repointed at paths that still EXIST on disk — a pure
//      existence check (the `check-stryker-modules.mjs` shape) would have
//      passed — while the surface silently collapsed from 607 mutants to
//      137. This guard checks reachability, not just existence.
//
//   3. `-o/--output DIR` creates `DIR/mutants.out`, not `DIR`. The workflow
//      passed `--output mutants-out` and then had the zero-coverage guard,
//      the step summary and the `file-mutation-survivors` filer all read
//      `mutants-out/…`. Every one of those paths was one level short of the
//      real files, so even a perfectly healthy run reported no coverage and
//      no survivors (the #3387 blocker).
//
// All three are checked here, statically, with no cargo invocation, so the
// hook is cheap enough to run on every commit that touches the config, the
// workflow, or the invariant-core sources it names.
//
// Parsing is line-based, per the convention the other workflow guards follow
// (`check-workflow-liveness.mjs`, `check-bench-lane-coverage.mjs`): scripts/
// carries no YAML or TOML runtime dependency. `js-yaml` and `smol-toml` are
// present in this tree only as `overrides` — transitive security pins, not
// declared dependencies — so importing them would be a lie about what the
// script needs.
//
// Usage:
//   node scripts/check-mutants-scope.mjs
//   node scripts/check-mutants-scope.mjs --root <dir>
//   node scripts/check-mutants-scope.mjs --self-test
//
// Exit: 0 = scope is live and the plumbing lines up, 1 = at least one
//       problem, 2 = bad usage / self-test failure.

import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/** Where cargo-mutants looks, and the pre-#3386 path that nothing reads. */
export const CONFIG_PATH = 'src-tauri/.cargo/mutants.toml'
export const STRAY_CONFIG_PATH = 'src-tauri/mutants.toml'
const WORKSPACE_DIR = 'src-tauri'
const WORKSPACE_MANIFEST = 'src-tauri/Cargo.toml'
const WORKFLOW_PATH = '.github/workflows/scheduled-deep-checks.yml'
const JOB_ID = 'mutants'

// ---------------------------------------------------------------------------
// Minimal TOML / YAML readers (see the header note on dependencies)
// ---------------------------------------------------------------------------

/** Lines with the whole-line `#` comments dropped. */
function uncommented(text) {
  return text.split('\n').filter((l) => !l.trimStart().startsWith('#'))
}

/**
 * The string array assigned to `key`, single- or multi-line. Returns `[]` when
 * the key is absent, which callers distinguish from "present but empty" via
 * `hasTomlKey`.
 */
export function tomlStringArray(text, key) {
  const lines = uncommented(text)
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=\\s*\\[`).test(l))
  if (start < 0) return []
  const out = []
  for (let i = start; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/"([^"]*)"/g)) out.push(m[1])
    if (lines[i].includes(']')) break
  }
  return out
}

function hasTomlKey(text, key) {
  return uncommented(text).some((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
}

function hasTomlSection(text, name) {
  return uncommented(text).some((l) => l.trim() === `[${name}]`)
}

/**
 * The lines of one top-level job in the workflow, comments dropped. Jobs are
 * indented two spaces, so the next line matching `/^ {2}\S/` ends the block.
 */
export function jobLines(text, jobId) {
  const lines = text.split('\n')
  const start = lines.indexOf(`  ${jobId}:`)
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).filter((l) => !l.trimStart().startsWith('#'))
}

/**
 * The `cargo mutants` invocation as a token list, plus the line indices it
 * spans (so its own `--output` argument is not mistaken for a reader path).
 */
export function findInvocation(lines) {
  const at = lines.findIndex((l) => /\bcargo mutants\b/.test(l))
  if (at < 0) return undefined
  let last = at
  while (last < lines.length - 1 && lines[last].trimEnd().endsWith('\\')) last++
  const joined = lines.slice(at, last + 1).join(' ')
  const from = joined.indexOf('cargo mutants')
  return {
    argv: joined.slice(from).replaceAll('\\', ' ').split(/\s+/).filter(Boolean),
    span: [at, last],
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function readWorkspace(root) {
  const text = readFileSync(resolve(root, WORKSPACE_MANIFEST), 'utf8')
  return {
    members: tomlStringArray(text, 'members'),
    // A root manifest that is ALSO a package is what makes the default member
    // set a single package instead of the whole workspace.
    rootIsPackage: hasTomlSection(text, 'package'),
    hasDefaultMembers: hasTomlKey(text, 'default-members'),
  }
}

/**
 * Which packages the lane's invocation generates mutants in, expressed as
 * member directory prefixes. `undefined` means "cannot be determined", which
 * is itself reported: an invocation whose package selection this guard cannot
 * model is one whose scope nobody is checking.
 */
export function examinedPackageDirs(argv, workspace) {
  if (argv.includes('--workspace')) return workspace.members
  const explicit = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-p' || argv[i] === '--package') explicit.push(argv[i + 1])
    const eq = /^--package=(.+)$/.exec(argv[i])
    if (eq) explicit.push(eq[1])
  }
  if (explicit.length > 0) return explicit.map((p) => (p === 'agaric' ? '.' : p))
  // No selection at all: cargo's default members. We only model the shape this
  // repo actually has (root manifest is a package, no `default-members` key →
  // the root package alone).
  if (workspace.rootIsPackage && !workspace.hasDefaultMembers) return ['.']
  return undefined
}

/**
 * True when `file` (workspace-relative) belongs to one of the packages in
 * `dirs`.
 *
 * `'.'` is the root manifest's own package and needs care: it does NOT own
 * everything under the workspace root, it owns everything that is not inside
 * some OTHER member's directory. Treating `'.'` as a wildcard would make the
 * whole reachability check vacuous — `agaric-store/src/op.rs` would count as
 * reachable from a bare `cargo mutants` that never mutates `agaric-store`,
 * which is precisely the bug this guard exists to catch. (The self-test
 * asserts this branch; it caught exactly that mistake while being written.)
 */
export function insideAny(file, dirs, allMembers = dirs) {
  const others = allMembers.filter((d) => d !== '.' && d !== '')
  return dirs.some((d) => {
    if (d === '.' || d === '') return !others.some((o) => file.startsWith(`${o}/`))
    return file === d || file.startsWith(`${d}/`)
  })
}

/** Where cargo-mutants will write, given the invocation (workspace-relative). */
export function outputDirFor(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--output') return `${argv[i + 1]}/mutants.out`
    const eq = /^--output=(.+)$/.exec(argv[i])
    if (eq) return `${eq[1]}/mutants.out`
  }
  return 'mutants.out'
}

/** Minimal glob match for `exclude_globs` (`**` and `*` only). */
export function globMatches(pattern, path) {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
  return new RegExp(`^${rx}$`).test(path)
}

/**
 * Every `examine_globs` entry must contribute at least one mutable file that
 * the lane can actually reach. Returns the number of such files, which is what
 * makes a clean result non-vacuous.
 */
function checkGlobReachability({ root, globs, excludes, examinedDirs, workspace, push }) {
  let matched = 0
  const wsRoot = resolve(root, WORKSPACE_DIR)
  const names = (examinedDirs ?? []).map((d) => (d === '.' ? '<root package>' : d)).join(', ')
  for (const glob of globs) {
    // cargo-mutants only ever mutates `.rs` files; a bare `**` also matches
    // directories, which would make an empty directory look like a hit.
    const hits = existsSync(wsRoot)
      ? globSync(glob, { cwd: wsRoot }).filter((p) => p.endsWith('.rs'))
      : []
    if (hits.length === 0) {
      push(
        'glob-matches-nothing',
        `examine_globs entry '${glob}' matches no .rs file under ${WORKSPACE_DIR}/. The lane's mutation surface silently shrinks by exactly that much.`,
      )
      continue
    }
    const live = hits.filter((p) => !excludes.some((e) => globMatches(e, p)))
    if (live.length === 0) {
      push(
        'glob-fully-excluded',
        `examine_globs entry '${glob}' matches ${hits.length} file(s), but exclude_globs removes all of them, so it contributes nothing.`,
      )
      continue
    }
    const unreachable =
      examinedDirs === undefined
        ? []
        : live.filter((p) => !insideAny(p, examinedDirs, workspace.members))
    if (examinedDirs !== undefined && unreachable.length === live.length) {
      push(
        'glob-outside-examined-packages',
        `examine_globs entry '${glob}' resolves to file(s) that EXIST but sit outside the packages this lane examines (${names}) — e.g. ${unreachable[0]}. cargo-mutants generates no mutants there, so the glob contributes zero. This is the #2621 arch-wave shape: the path was repointed when the code moved packages, the file still exists, and the surface collapsed anyway.`,
      )
      continue
    }
    matched += live.length - unreachable.length
  }
  return matched
}

/**
 * Every path the lane's own steps read must be where cargo-mutants writes.
 * `-o/--output DIR` creates `DIR/mutants.out`, so a reader pointed at `DIR`
 * finds nothing however healthy the run was.
 */
export function checkOutputPlumbing({ lines, invocation, push }) {
  const writeDir = outputDirFor(invocation.argv)
  const [from, to] = invocation.span

  // A prefix test is NOT a path test. cargo-mutants renames the previous run's
  // directory to `mutants.out.old` (it is in .gitignore for exactly that
  // reason), and `'mutants.out.old/missed.txt'.startsWith('mutants.out')` is
  // true — so a bare `startsWith` waves through a reader pointed at LAST
  // week's results, which is a silent-staleness bug of the same family this
  // guard exists to catch. Require a path-segment boundary.
  const under = (ref) => ref === writeDir || ref.startsWith(`${writeDir}/`)

  // The artifact steps are collected rather than checked inline, because the
  // interesting failures are ABSENCES: a `path:` that no longer mentions
  // `mutants.out` at all, or an upload step that was deleted outright. Both
  // used to slip through, since the inline check only ran on a `path:` that
  // already looked roughly right — a guard that validates a value only when
  // it is nearly correct cannot fail on the cases that matter.
  const uploads = []
  let step = '<unnamed step>'
  let currentUpload
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s+(name|uses):/.test(lines[i])) currentUpload = undefined
    const stepName = /^\s*-\s+name:\s*(.+?)\s*$/.exec(lines[i])
    if (stepName) step = `step '${stepName[1]}'`
    if (/uses:\s*actions\/upload-artifact/.test(lines[i])) {
      currentUpload = { step, path: undefined }
      uploads.push(currentUpload)
    }
    const pathLine = /^\s*path:\s*(\S+)\s*$/.exec(lines[i])
    if (pathLine && currentUpload && currentUpload.path === undefined) {
      currentUpload.path = pathLine[1]
    }
    if (i >= from && i <= to) continue
    // `name:` values are step names and the upload-artifact ARTIFACT name —
    // never paths. Scanning them would flag `name: mutants-out` as a reader.
    const refs = /^\s*-?\s*name:\s*/.test(lines[i])
      ? []
      : new Set(lines[i].match(/mutants[-.]out[^\s"'`)]*/g) ?? [])
    for (const ref of refs) {
      if (under(ref)) continue
      push(
        'output-path-mismatch',
        `${step} reads '${ref}', but cargo-mutants writes to '${writeDir}' (\`--output DIR\` creates DIR/mutants.out, it does not USE DIR; \`${writeDir}.old\` is the PREVIOUS run). A step reading one level short of — or one run behind — the real files reports zero coverage and zero survivors however healthy the run was.`,
      )
    }
  }

  if (uploads.length === 0) {
    push(
      'artifact-upload-missing',
      `the \`${JOB_ID}\` job uploads no artifact at all (no \`actions/upload-artifact\` step). \`file-mutation-survivors --require-rust\` downloads that artifact and throws when missed.txt is not in it, so the survivor-filing job goes red with a message about the filer rather than about this job (#3387).`,
    )
  }
  for (const upload of uploads) {
    if (upload.path === undefined) {
      push(
        'artifact-path-missing',
        `${upload.step} uses actions/upload-artifact with no \`path:\`, so it uploads the default (the whole workspace) instead of '${WORKSPACE_DIR}/${writeDir}'.`,
      )
      continue
    }
    if (upload.path.replace(/^src-tauri\//, '').replace(/\/$/, '') !== writeDir) {
      push(
        'artifact-path-mismatch',
        `${upload.step} uploads '${upload.path}', but the artifact must be cargo-mutants' output directory ITSELF ('${WORKSPACE_DIR}/${writeDir}'). \`file-mutation-survivors\` reads missed.txt flat off the artifact root; uploading a parent directory buries it one level down and the filer's --require-rust throws (#3387).`,
      )
    }
  }
}

/**
 * Pure analysis. Returns every problem found, plus the counts that make a
 * clean result meaningful rather than vacuous.
 *
 * `overrideArgv` exists only so the self-test can drive the REAL config
 * through a different invocation and prove the failure path fires.
 */
export function analyzeMutantsScope({ root, overrideArgv }) {
  const problems = []
  const push = (kind, detail) => problems.push({ kind, detail })

  const configAbs = resolve(root, CONFIG_PATH)
  if (!existsSync(configAbs)) {
    push(
      'config-missing',
      `${CONFIG_PATH} does not exist. cargo-mutants reads its config from this path ONLY; anywhere else and it silently falls back to Config::default() — whole-crate mutation surface, \`cargo test\` instead of nextest, no exclude_globs.`,
    )
    return { problems, globs: [], matched: 0, examinedDirs: [] }
  }
  if (existsSync(resolve(root, STRAY_CONFIG_PATH))) {
    push(
      'config-stray',
      `${STRAY_CONFIG_PATH} exists. Nothing reads it — it is the pre-#3386 location, and leaving a copy there invites edits that have no effect. Delete it; ${CONFIG_PATH} is the live file.`,
    )
  }

  const config = readFileSync(configAbs, 'utf8')
  const globs = tomlStringArray(config, 'examine_globs')
  const excludes = tomlStringArray(config, 'exclude_globs')
  if (globs.length === 0) {
    push(
      'no-examine-globs',
      `${CONFIG_PATH} declares no examine_globs, so the lane would mutate every package it examines in full — hours of runner time and a survivor list nobody can triage.`,
    )
  }

  const workspace = readWorkspace(root)
  const workflowAbs = resolve(root, WORKFLOW_PATH)
  const lines = existsSync(workflowAbs)
    ? jobLines(readFileSync(workflowAbs, 'utf8'), JOB_ID)
    : undefined
  const invocation = overrideArgv
    ? { argv: overrideArgv, span: [-1, -1] }
    : lines && findInvocation(lines)
  if (!invocation) {
    push(
      'no-invocation',
      `no \`cargo mutants\` step found in the \`${JOB_ID}\` job of ${WORKFLOW_PATH}. Without it neither the package selection nor the output path can be checked.`,
    )
  }

  const examinedDirs = invocation ? examinedPackageDirs(invocation.argv, workspace) : undefined
  if (invocation && examinedDirs === undefined) {
    push(
      'package-selection-unknown',
      `cannot determine which packages the lane examines from its \`cargo mutants\` invocation. Pass \`--workspace\` or an explicit \`-p\`, so the scope is stated rather than inherited from cargo's default-member rules.`,
    )
  }

  const matched = checkGlobReachability({ root, globs, excludes, examinedDirs, workspace, push })
  if (invocation && lines) checkOutputPlumbing({ lines, invocation, push })

  return { problems, globs, matched, examinedDirs: examinedDirs ?? [] }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(root = REPO_ROOT) {
  const { problems, globs, matched, examinedDirs } = analyzeMutantsScope({ root })
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ mutants scope [${p.kind}]: ${p.detail}`)
    console.error(
      `\n${problems.length} problem(s) with the Rust mutation lane's scope or plumbing. Each one makes the lane produce zero coverage while still exiting 0 from \`cargo mutants ... || true\` (#3386, #3057).`,
    )
    process.exit(1)
  }
  const where = examinedDirs.map((d) => (d === '.' ? '<root package>' : d)).join(', ')
  console.log(
    `mutants scope OK: ${globs.length} examine_glob(s) resolve to ${matched} mutable file(s) inside the examined package(s) [${where}], and every step reads where cargo-mutants writes`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
/**
 * The readers everything above stands on: if the TOML array parser or the
 * workflow slicer silently returns nothing, every other check "passes" while
 * inspecting an empty set.
 */
function selfTestReaders(ok, fail) {
  // `--output DIR` nests: DIR/mutants.out, not DIR. The bug that made every
  // reader path one level short.
  if (outputDirFor(['cargo', 'mutants', '--output', 'mutants-out']) === 'mutants-out/mutants.out')
    ok('--output DIR resolves to DIR/mutants.out')
  else fail('--output nesting', outputDirFor(['cargo', 'mutants', '--output', 'mutants-out']))
  if (outputDirFor(['cargo', 'mutants', '--in-place']) === 'mutants.out')
    ok('no --output resolves to the default mutants.out')
  else fail('default output dir', outputDirFor(['cargo', 'mutants']))

  // exclude_globs matching, used to prove a glob is not fully excluded.
  if (
    globMatches('**/tests/**', 'agaric-store/src/op_log/tests/x.rs') &&
    !globMatches('**/tests/**', 'src/reverse/batch.rs')
  )
    ok('exclude_globs matching distinguishes harness files from sources')
  else fail('exclude_globs matching', 'pattern semantics wrong')

  // The hand-rolled TOML reader must handle both array spellings.
  const multi = tomlStringArray(
    'examine_globs = [\n  "a/**",\n  # comment\n  "b.rs",\n]\n',
    'examine_globs',
  )
  const single = tomlStringArray('members = [".", "x"]\n', 'members')
  if (multi.join() === 'a/**,b.rs' && single.join() === '.,x')
    ok('TOML string arrays parse in both single- and multi-line form')
  else fail('TOML array parsing', JSON.stringify({ multi, single }))

  // The workflow reader must find the real job and its real invocation.
  const jl = jobLines(readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), 'utf8'), JOB_ID)
  const inv = jl && findInvocation(jl)
  if (jl && inv && inv.argv[0] === 'cargo' && inv.argv.includes('--in-place'))
    ok('the real workflow job and its cargo-mutants invocation are found')
  else fail('workflow parsing', JSON.stringify({ job: Boolean(jl), argv: inv?.argv?.slice(0, 6) }))
}

/**
 * The output-plumbing checks, driven through synthetic job lines. Every one of
 * these three fired GREEN before they were added: the artifact `path:` was
 * only validated when it already contained `mutants.out`, a deleted upload
 * step was not noticed at all, and the reader check used a bare `startsWith`
 * that accepted the rotated `mutants.out.old` directory.
 */
function selfTestPlumbing(ok, fail) {
  const kinds = (lines, argv = ['cargo', 'mutants', '--in-place']) => {
    const found = []
    checkOutputPlumbing({
      lines,
      invocation: { argv, span: [-1, -1] },
      push: (kind) => found.push(kind),
    })
    return found
  }
  const job = (readerLine, uploadLines) => [
    '      - name: Zero-coverage guard',
    '        run: |',
    `          ${readerLine}`,
    ...uploadLines,
  ]
  const UPLOAD = [
    '      - name: Upload mutants report',
    '        uses: actions/upload-artifact@0000',
    '        with:',
    '          name: mutants-out',
    '          path: src-tauri/mutants.out/',
  ]

  const clean = kinds(job('outcomes=mutants.out/outcomes.json', UPLOAD))
  if (clean.length === 0) ok('a correctly plumbed job reports no problem')
  else fail('clean job is clean', JSON.stringify(clean))

  const rotated = kinds(job('outcomes=mutants.out.old/outcomes.json', UPLOAD))
  if (rotated.includes('output-path-mismatch'))
    ok('a reader pointed at the rotated mutants.out.old is flagged')
  else fail('rotated-dir reader is flagged', JSON.stringify(rotated))

  const renamed = kinds(
    job('outcomes=mutants.out/outcomes.json', [
      ...UPLOAD.slice(0, 4),
      '          path: src-tauri/results/',
    ]),
  )
  if (renamed.includes('artifact-path-mismatch'))
    ok('an artifact path renamed away from mutants.out is flagged')
  else fail('renamed artifact path is flagged', JSON.stringify(renamed))

  const deleted = kinds(job('outcomes=mutants.out/outcomes.json', []))
  if (deleted.includes('artifact-upload-missing')) ok('a deleted upload-artifact step is flagged')
  else fail('missing upload step is flagged', JSON.stringify(deleted))
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // 1. The REAL tree must be clean. This is the assertion that actually
  //    protects the lane, and the reason this guard is not vacuous.
  const real = analyzeMutantsScope({ root: REPO_ROOT })
  if (real.problems.length === 0 && real.matched > 0)
    ok(`the real config resolves ${real.matched} mutable file(s) in reachable packages`)
  else fail('the real config is clean', JSON.stringify(real.problems))

  // 2. A glob whose files exist but sit in an unexamined package is flagged.
  //    This is the #2621 shape, and the case a pure existence check misses.
  const MEMBERS = ['.', 'agaric-store']
  const ws = { members: MEMBERS, rootIsPackage: true, hasDefaultMembers: false }
  const bare = examinedPackageDirs(['cargo', 'mutants', '--in-place', '--timeout', '900'], ws)
  if (
    Array.isArray(bare) &&
    bare.length === 1 &&
    bare[0] === '.' &&
    !insideAny('agaric-store/src/op.rs', bare, MEMBERS) &&
    // …while the root package's OWN files stay reachable, or the check would
    // "pass" by rejecting everything.
    insideAny('src/reverse/batch.rs', bare, MEMBERS)
  )
    ok('a bare invocation examines only the root package, so a moved-out glob is unreachable')
  else fail('bare invocation package selection', JSON.stringify(bare))

  // 3. …and `--workspace` makes it reachable again.
  const all = examinedPackageDirs(['cargo', 'mutants', '--workspace'], ws)
  if (
    insideAny('agaric-store/src/op.rs', all, MEMBERS) &&
    insideAny('src/reverse/batch.rs', all, MEMBERS)
  )
    ok('--workspace makes a moved-out glob reachable')
  else fail('--workspace package selection', JSON.stringify(all))

  // 4. End-to-end: the REAL config, analysed against an invocation with no
  //    `--workspace`, must report all three moved-out globs. This is the
  //    guard's whole reason to exist, exercised through `analyzeMutantsScope`
  //    rather than its helpers.
  const drifted = analyzeMutantsScope({
    root: REPO_ROOT,
    overrideArgv: ['cargo', 'mutants', '--in-place'],
  })
  if (drifted.problems.filter((p) => p.kind === 'glob-outside-examined-packages').length === 3)
    ok('dropping --workspace flags all three moved-out globs (the #2621 drift)')
  else fail('moved-out globs are flagged', JSON.stringify(drifted.problems.map((p) => p.kind)))

  selfTestReaders(ok, fail)
  selfTestPlumbing(ok, fail)

  // 5. End-to-end on a root with no config at all → config-missing.
  const empty = analyzeMutantsScope({ root: resolve(REPO_ROOT, 'scripts') })
  if (empty.problems.some((p) => p.kind === 'config-missing')) ok('a missing config is flagged')
  else fail('missing config is flagged', JSON.stringify(empty.problems.map((p) => p.kind)))

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
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    runSelfTest()
  } else if (argv[0] === '--root' && argv.length === 2) {
    // Resolve against a different root so the gating vitest test can assert
    // the NON-ZERO exit end-to-end. A guard whose failure path is never
    // executed is decoration.
    main(argv[1])
  } else if (argv.length > 0) {
    console.error(`unknown argument: ${argv[0]}`)
    process.exit(2)
  } else {
    main()
  }
}
