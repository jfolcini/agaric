#!/usr/bin/env node
// #4408 — `oxlint --type-aware` runs a SECOND analyser (`oxlint-tsgolint`, a
// typescript-go build shipped as its own npm package) alongside oxlint's
// syntax pass. Three devDependencies therefore have to agree, and nothing in
// npm's own resolution makes them:
//
//   * `typescript`        — the compiler the repo's source is written against.
//   * `oxlint-tsgolint`   — a typescript-go binary, versioned to TRACK a
//                           TypeScript release (`7.0.2001` ships TS `7.0.2`'s
//                           checker). It embeds its own compiler; it does NOT
//                           read the `typescript` package off disk.
//   * `oxlint`            — declares `oxlint-tsgolint` as an OPTIONAL peer
//                           dependency (`>=7.0.2001` as of 1.79/1.80), so npm
//                           installs happily with it absent or stale and only
//                           `--type-aware` notices.
//
// ─── The two failure modes ────────────────────────────────────────────────
//
// 1. ABSENT. This is the state #4408 was filed for: `oxlint-tsgolint` was
//    never added, so `npx oxlint --type-aware` died with "Failed to find
//    tsgolint executable" and every type-aware `typescript/*` rule in
//    `.oxlintrc.json` (`only-throw-error`, `require-await`) was inert
//    configuration that had never once been evaluated. Loud, but only for
//    whoever typed `--type-aware` by hand — nothing in a gate ran it.
//
// 2. DRIFTED, which is worse. Bump `typescript` and leave `oxlint-tsgolint`
//    behind and type-aware still STARTS: the old typescript-go binary
//    silently analyses today's source against yesterday's checker. Findings
//    that depend on new type-system behaviour are simply not produced, and
//    the run exits 0 looking like a pass. There is no version negotiation
//    between the two packages to catch this — the pairing is a convention,
//    which is exactly the kind of thing that needs a guard rather than a
//    comment.
//
// ─── Why a hand-maintained table, and not arithmetic ──────────────────────
//
// `oxlint-tsgolint@7.0.2001` pairs with `typescript@7.0.2`, and it is
// tempting to encode that as `patch === tsPatch * 1000 + n`. Resist it. The
// scheme is not documented anywhere — not in the package README, not in the
// tsgolint release notes, not in oxc's — and only TWO releases have ever used
// it (`7.0.2000` and `7.0.2001`, both 2026-07-21, against the single TS 7.x
// stable `7.0.2`). Two data points do not establish a formula, and a guard
// built on a guessed one would either wave through a genuinely mismatched
// pair or block a legitimate one, with the same confident message either way.
//
// So `VERIFIED_PAIRS` below is an explicit list of pairs somebody has
// actually run `oxlint --type-aware` against. Bumping EITHER package fails
// this guard until a human adds the new row — that friction IS the
// enforcement #4408 point 4 asks for. The failure message says so.
//
// The other two checks need no table: `oxlint` records its own
// `peerDependencies` range in `package-lock.json`, so "tsgolint older than
// the oxlint in this tree demands" is checkable against the authority that
// declared it, and "not installed at all" is checkable outright.
//
// ─── Exit codes ───────────────────────────────────────────────────────────
//
//   0  every check passed
//   2  a real finding (absent / drifted / below oxlint's declared floor),
//      or a `--self-test` assertion failure
//   3  UNVERIFIABLE — the guard could not reach a verdict (a manifest is
//      missing or unparseable, oxlint stopped recording its peer range, a
//      dependency range uses a form this script does not parse). Non-zero on
//      purpose: "I could not check" must fail the hook, never read as a pass.
//
// 1 is deliberately UNUSED. Node exits 1 on an uncaught throw, so if 1 also
// meant "real finding" a crash in this guard would be indistinguishable from
// a genuine version drift — the caller would see a red hook with a plausible
// story and fix the wrong thing. The sibling pin guards
// (check-prek-version-pin.mjs, check-zizmor-version-pin.mjs) do overload 1
// this way; this script deliberately does not.
//
// Usage:
//   node scripts/check-tsgolint-version-pin.mjs
//   node scripts/check-tsgolint-version-pin.mjs --self-test

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json')
const PACKAGE_LOCK_PATH = join(REPO_ROOT, 'package-lock.json')

export const EXIT_CLEAN = 0
export const EXIT_FINDING = 2
export const EXIT_UNVERIFIABLE = 3

export const TSGOLINT = 'oxlint-tsgolint'
export const TYPESCRIPT = 'typescript'
export const OXLINT = 'oxlint'

/**
 * Every (`typescript`, `oxlint-tsgolint`) pair somebody has actually run
 * `oxlint --type-aware` against in this repo. Add a row — with the issue or
 * PR that ran it — when you bump either package. Do not derive rows.
 */
export const VERIFIED_PAIRS = [
  {
    typescript: '7.0.2',
    tsgolint: '7.0.2001',
    evidence:
      '#4408: `npx oxlint --type-aware` ran clean-starting against this pair and produced 643 findings (246 syntax + 397 type-aware) in ~4s',
  },
]

/** Thrown when the guard cannot reach a verdict at all (exit 3, never 2). */
export class UnverifiableError extends Error {}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/** `{ major, minor, patch }`, or `null` when `v` is not a bare X.Y.Z. */
export function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** -1 / 0 / 1. Throws `UnverifiableError` on anything not a bare X.Y.Z. */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa) throw new UnverifiableError(`not a plain X.Y.Z version: ${JSON.stringify(a)}`)
  if (!pb) throw new UnverifiableError(`not a plain X.Y.Z version: ${JSON.stringify(b)}`)
  for (const part of ['major', 'minor', 'patch']) {
    if (pa[part] !== pb[part]) return pa[part] < pb[part] ? -1 : 1
  }
  return 0
}

const UPPER_BOUND_FOR = {
  // `^X.Y.Z` on a non-zero major: anything below the next major.
  '^': (p) => (p.major > 0 ? { major: p.major + 1, minor: 0, patch: 0 } : null),
  // `~X.Y.Z`: anything below the next minor.
  '~': (p) => ({ major: p.major, minor: p.minor + 1, patch: 0 }),
}

function below(version, bound) {
  return compareVersions(version, `${bound.major}.${bound.minor}.${bound.patch}`) < 0
}

/**
 * Whether `version` satisfies `range`, for the small set of range forms npm
 * actually writes into this repo's manifests: `*`, a bare `X.Y.Z`, and a
 * single `=` / `>=` / `>` / `^` / `~` operator.
 *
 * Every other form — unions (`||`), hyphen ranges, whitespace-joined
 * conjunctions, `<`/`<=` upper bounds, prereleases — throws
 * `UnverifiableError` rather than being approximated. A range this script
 * quietly mis-parsed would produce a WRONG verdict in either direction; exit
 * 3 says "teach me this form" and fails the hook until somebody does.
 */
export function satisfiesRange(version, range) {
  if (typeof range !== 'string') {
    throw new UnverifiableError(`range is not a string: ${JSON.stringify(range)}`)
  }
  const r = range.trim()
  if (r === '*' || r === 'x' || r === '') return true
  const m = r.match(/^(>=|>|\^|~|=)?\s*(\d+\.\d+\.\d+)$/)
  if (!m) {
    throw new UnverifiableError(
      `dependency range ${JSON.stringify(range)} uses a form this guard does not parse ` +
        '(only `*`, `X.Y.Z`, and a single `=`/`>=`/`>`/`^`/`~` operator are supported) — ' +
        'extend satisfiesRange() rather than loosening the check',
    )
  }
  const [, op = '=', base] = m
  if (op === '=') return compareVersions(version, base) === 0
  if (op === '>=') return compareVersions(version, base) >= 0
  if (op === '>') return compareVersions(version, base) > 0
  const bound = UPPER_BOUND_FOR[op](parseVersion(base))
  if (!bound) {
    throw new UnverifiableError(
      `range ${JSON.stringify(range)} is a caret on a 0.x version, whose npm semantics this guard does not model`,
    )
  }
  return compareVersions(version, base) >= 0 && below(version, bound)
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

function readJson(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new UnverifiableError(`cannot read ${label} (${path}): ${err.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new UnverifiableError(`cannot parse ${label} (${path}) as JSON: ${err.message}`)
  }
}

/**
 * The three declared ranges and the three resolved versions, plus the
 * `oxlint-tsgolint` peer range oxlint itself declares. Reads the LOCK for
 * resolved versions rather than `node_modules/`, so the guard gives the same
 * answer on a machine that has not installed yet.
 */
export function readPinState({ pkg, lock }) {
  const declared = pkg.devDependencies ?? {}
  const packages = lock.packages
  if (!packages || typeof packages !== 'object') {
    throw new UnverifiableError(
      'package-lock.json has no `packages` map — this guard reads resolved versions from ' +
        'lockfileVersion 2/3 only; a v1 lock needs different extraction',
    )
  }
  const entryFor = (name) => packages[`node_modules/${name}`]
  return {
    declared: {
      [TYPESCRIPT]: declared[TYPESCRIPT],
      [TSGOLINT]: declared[TSGOLINT],
      [OXLINT]: declared[OXLINT],
    },
    resolved: {
      [TYPESCRIPT]: entryFor(TYPESCRIPT)?.version,
      [TSGOLINT]: entryFor(TSGOLINT)?.version,
      [OXLINT]: entryFor(OXLINT)?.version,
    },
    oxlintPeerRange: entryFor(OXLINT)?.peerDependencies?.[TSGOLINT],
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const finding = (message) => ({ severity: 'finding', message })
const unverifiable = (message) => ({ severity: 'unverifiable', message })

/** The #4408 state itself: the package is simply not there. */
function checkPresence({ declared, resolved }) {
  const problems = []
  if (!declared[TSGOLINT]) {
    problems.push(
      finding(
        `${TSGOLINT} is not a devDependency in package.json — \`oxlint --type-aware\` cannot run ` +
          '("Failed to find tsgolint executable"), so every type-aware `typescript/*` rule in ' +
          '.oxlintrc.json is inert configuration (#4408)',
      ),
    )
  } else if (!resolved[TSGOLINT]) {
    problems.push(
      finding(
        `${TSGOLINT} is declared in package.json (${declared[TSGOLINT]}) but package-lock.json ` +
          'resolves no version for it — the lock is out of date with the manifest; run `npm install`',
      ),
    )
  }
  for (const name of [TYPESCRIPT, OXLINT]) {
    if (!declared[name] || !resolved[name]) {
      problems.push(
        unverifiable(
          `${name} is missing from package.json devDependencies or from package-lock.json, so ` +
            'the tsgolint pairing has nothing to be checked against',
        ),
      )
    }
  }
  return problems
}

/** oxlint's OWN declared floor for the tsgolint it will shell out to. */
function checkOxlintPeerFloor({ resolved, oxlintPeerRange }) {
  if (!resolved[TSGOLINT] || !resolved[OXLINT]) return []
  if (oxlintPeerRange === undefined) {
    return [
      unverifiable(
        `package-lock.json's ${OXLINT} entry records no \`peerDependencies["${TSGOLINT}"]\` range. ` +
          'oxlint 1.79/1.80 both declare one, so its disappearance means the coupling moved ' +
          "somewhere this guard does not look — re-read oxlint's packaging before trusting a green run",
      ),
    ]
  }
  if (!satisfiesRange(resolved[TSGOLINT], oxlintPeerRange)) {
    return [
      finding(
        `${TSGOLINT}@${resolved[TSGOLINT]} does not satisfy the range ${OXLINT}@${resolved[OXLINT]} ` +
          `declares for it (${oxlintPeerRange}). oxlint makes this peer OPTIONAL, so npm installed ` +
          'the mismatch without a word and only a `--type-aware` run would surface it',
      ),
    ]
  }
  return []
}

/** The pairing itself, against the hand-verified table. */
function checkVerifiedPair({ resolved }) {
  if (!resolved[TSGOLINT] || !resolved[TYPESCRIPT]) return []
  if (VERIFIED_PAIRS.length === 0) {
    return [
      finding(
        'VERIFIED_PAIRS is empty, so this guard would pass anything — an empty table is a broken ' +
          'guard, not a permissive one',
      ),
    ]
  }
  const matched = VERIFIED_PAIRS.some(
    (p) => p.typescript === resolved[TYPESCRIPT] && p.tsgolint === resolved[TSGOLINT],
  )
  if (matched) return []
  const known = VERIFIED_PAIRS.map(
    (p) => `${TYPESCRIPT}@${p.typescript} + ${TSGOLINT}@${p.tsgolint}`,
  )
  return [
    finding(
      `${TYPESCRIPT}@${resolved[TYPESCRIPT]} + ${TSGOLINT}@${resolved[TSGOLINT]} is not a pair anyone ` +
        `has verified. Verified: ${known.join('; ')}. ${TSGOLINT} embeds its OWN typescript-go ` +
        'checker rather than reading the `typescript` package, so a mismatch does not fail loudly — ' +
        'it analyses current source against a different compiler and exits 0. To clear this: pick ' +
        `the ${TSGOLINT} release built for this ${TYPESCRIPT} version (\`npm view ${TSGOLINT} versions\`), ` +
        'install it, run `npx oxlint --type-aware` yourself, then add the pair to VERIFIED_PAIRS ' +
        'with what you ran as its evidence (#4408)',
    ),
  ]
}

/** Every problem, worst-first by the order the checks run. */
export function collectProblems(state) {
  return [...checkPresence(state), ...checkOxlintPeerFloor(state), ...checkVerifiedPair(state)]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run({ packageJsonPath = PACKAGE_JSON_PATH, lockPath = PACKAGE_LOCK_PATH } = {}) {
  let problems
  let state
  try {
    state = readPinState({
      pkg: readJson(packageJsonPath, 'package.json'),
      lock: readJson(lockPath, 'package-lock.json'),
    })
    problems = collectProblems(state)
  } catch (err) {
    if (err instanceof UnverifiableError)
      return { code: EXIT_UNVERIFIABLE, problems: [unverifiable(err.message)] }
    throw err
  }
  const findings = problems.filter((p) => p.severity === 'finding')
  // A definite finding outranks an unverifiable one: it is the actionable
  // half, and reporting 3 would tell the caller to go fix their toolchain
  // when what is actually wrong is the pin.
  if (findings.length > 0) return { code: EXIT_FINDING, problems, state }
  if (problems.length > 0) return { code: EXIT_UNVERIFIABLE, problems, state }
  return { code: EXIT_CLEAN, problems, state }
}

export function main() {
  const { code, problems, state } = run()
  if (code === EXIT_CLEAN) {
    console.log(
      `OK  type-aware lint version pin: ${TYPESCRIPT}@${state.resolved[TYPESCRIPT]} + ` +
        `${TSGOLINT}@${state.resolved[TSGOLINT]} is a verified pair, and satisfies ` +
        `${OXLINT}@${state.resolved[OXLINT]}'s declared peer range (${state.oxlintPeerRange})`,
    )
    return code
  }
  const label = code === EXIT_FINDING ? 'FAIL' : 'UNVERIFIABLE'
  console.error(`${label}  check-tsgolint-version-pin (#4408):`)
  for (const p of problems) console.error(`  - [${p.severity}] ${p.message}`)
  return code
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

const HEALTHY_PKG = {
  devDependencies: { typescript: '^7.0.2', oxlint: '^1.79.0', 'oxlint-tsgolint': '^7.0.2001' },
}
const healthyLock = (overrides = {}) => ({
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/typescript': { version: '7.0.2' },
    'node_modules/oxlint': {
      version: '1.79.0',
      peerDependencies: { 'oxlint-tsgolint': '>=7.0.2001', 'vite-plus': '*' },
    },
    'node_modules/oxlint-tsgolint': { version: '7.0.2001' },
    ...overrides,
  },
})

function stateOf(pkg, lock) {
  return readPinState({ pkg, lock })
}

function selfTestVersions({ check }) {
  check(parseVersion('7.0.2001')?.patch === 2001, 'a four-digit patch parses as a patch', '')
  check(parseVersion('7.0.2-rc') === null, 'a prerelease is not silently truncated to X.Y.Z', '')
  check(compareVersions('7.0.2001', '7.0.2000') === 1, '7.0.2001 sorts above 7.0.2000', '')
  check(compareVersions('7.0.2', '7.0.2') === 0, 'equal versions compare equal', '')

  check(
    satisfiesRange('7.0.2001', '>=7.0.2001'),
    "oxlint's real floor admits the real tsgolint",
    '',
  )
  check(
    !satisfiesRange('7.0.2000', '>=7.0.2001'),
    'the release one BELOW the floor oxlint 1.79/1.80 declares is rejected',
    '',
  )
  check(satisfiesRange('7.1.0', '^7.0.2001'), 'a caret admits a higher minor', '')
  check(!satisfiesRange('8.0.0', '^7.0.2001'), 'a caret stops at the next major', '')
  check(satisfiesRange('7.0.2002', '~7.0.2001'), 'a tilde admits a higher patch', '')
  check(!satisfiesRange('7.1.0', '~7.0.2001'), 'a tilde stops at the next minor', '')
  check(satisfiesRange('9.9.9', '*'), 'a star admits anything', '')

  for (const bad of ['>=7.0.0 <8.0.0', '7 || 8', '7.0.2 - 7.9.9', '<8.0.0', '^0.25.0']) {
    let threw = null
    try {
      satisfiesRange('7.0.2001', bad)
    } catch (err) {
      threw = err
    }
    check(
      threw instanceof UnverifiableError,
      `an unparsed range form (${bad}) is UNVERIFIABLE, not an assumed pass`,
      String(threw),
    )
  }
}

function selfTestHealthy({ check }) {
  const problems = collectProblems(stateOf(HEALTHY_PKG, healthyLock()))
  check(problems.length === 0, 'the healthy pair produces no problems', JSON.stringify(problems))
}

function selfTestAbsent({ check }) {
  // The literal #4408 state: typescript and oxlint present, tsgolint nowhere.
  const pkg = { devDependencies: { typescript: '^7.0.2', oxlint: '^1.79.0' } }
  const lock = healthyLock()
  delete lock.packages['node_modules/oxlint-tsgolint']
  const problems = collectProblems(stateOf(pkg, lock))
  check(
    problems.length === 1 &&
      problems[0].severity === 'finding' &&
      problems[0].message.includes('not a devDependency'),
    'the exact #4408 state (tsgolint absent entirely) is a FINDING naming the missing devDependency',
    JSON.stringify(problems),
  )
}

function selfTestLockLagsManifest({ check }) {
  const lock = healthyLock()
  delete lock.packages['node_modules/oxlint-tsgolint']
  const problems = collectProblems(stateOf(HEALTHY_PKG, lock))
  check(
    problems.some((p) => p.severity === 'finding' && p.message.includes('resolves no version')),
    'declared in package.json but absent from the lock is a finding, not a pass',
    JSON.stringify(problems),
  )
}

function selfTestTypescriptBumpLeavesTsgolintBehind({ check }) {
  // #4408 point 4, the whole reason this guard exists.
  const pkg = {
    devDependencies: { typescript: '^7.0.3', oxlint: '^1.79.0', 'oxlint-tsgolint': '^7.0.2001' },
  }
  const lock = healthyLock({ 'node_modules/typescript': { version: '7.0.3' } })
  const problems = collectProblems(stateOf(pkg, lock))
  check(
    problems.length === 1 &&
      problems[0].severity === 'finding' &&
      problems[0].message.includes('7.0.3') &&
      problems[0].message.includes('7.0.2001'),
    'bumping typescript while leaving oxlint-tsgolint behind is caught, and both versions are named',
    JSON.stringify(problems),
  )
}

function selfTestTsgolintBumpLeavesTypescriptBehind({ check }) {
  const lock = healthyLock({ 'node_modules/oxlint-tsgolint': { version: '7.0.2002' } })
  const problems = collectProblems(stateOf(HEALTHY_PKG, lock))
  check(
    problems.some((p) => p.severity === 'finding' && p.message.includes('7.0.2002')),
    'the drift is caught from the OTHER side too — bumping tsgolint alone is equally a finding',
    JSON.stringify(problems),
  )
}

function selfTestBelowOxlintFloor({ check }) {
  const pkg = {
    devDependencies: { typescript: '^7.0.2', oxlint: '^1.79.0', 'oxlint-tsgolint': '^0.25.0' },
  }
  const lock = healthyLock({ 'node_modules/oxlint-tsgolint': { version: '7.0.2000' } })
  const problems = collectProblems(stateOf(pkg, lock))
  check(
    problems.some(
      (p) => p.severity === 'finding' && p.message.includes('does not satisfy the range'),
    ),
    "a tsgolint below oxlint's own declared peer floor is caught independently of the table",
    JSON.stringify(problems),
  )
}

function selfTestPeerRangeVanished({ check }) {
  const lock = healthyLock({ 'node_modules/oxlint': { version: '1.79.0' } })
  const problems = collectProblems(stateOf(HEALTHY_PKG, lock))
  check(
    problems.length === 1 && problems[0].severity === 'unverifiable',
    'oxlint no longer recording its peer range is UNVERIFIABLE (exit 3), not a silent pass',
    JSON.stringify(problems),
  )
}

function selfTestExitCodes({ check }) {
  check(
    EXIT_CLEAN === 0 && EXIT_FINDING === 2 && EXIT_UNVERIFIABLE === 3,
    'exit codes are 0/2/3 — 1 stays reserved for an uncaught crash so the two cannot alias',
    '',
  )
  const missing = run({ packageJsonPath: join(REPO_ROOT, 'no-such-package.json') })
  check(
    missing.code === EXIT_UNVERIFIABLE,
    'an unreadable manifest exits 3 (unverifiable), never 0 and never 2',
    JSON.stringify(missing),
  )
}

function selfTestRealRepo({ check, fail }) {
  const result = run()
  if (result.code === EXIT_CLEAN) {
    check(
      true,
      `the real repo pins a verified pair (${TYPESCRIPT}@${result.state.resolved[TYPESCRIPT]} + ` +
        `${TSGOLINT}@${result.state.resolved[TSGOLINT]})`,
      '',
    )
    return
  }
  fail(
    'the real repo pins a verified pair',
    result.problems.map((p) => `[${p.severity}] ${p.message}`).join(' | '),
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

  selfTestVersions({ check })
  selfTestHealthy({ check })
  selfTestAbsent({ check })
  selfTestLockLagsManifest({ check })
  selfTestTypescriptBumpLeavesTsgolintBehind({ check })
  selfTestTsgolintBumpLeavesTypescriptBehind({ check })
  selfTestBelowOxlintFloor({ check })
  selfTestPeerRangeVanished({ check })
  selfTestExitCodes({ check })
  selfTestRealRepo({ check, fail })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    return EXIT_FINDING
  }
  console.log('self-test: all assertions passed')
  return EXIT_CLEAN
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  process.exit(process.argv.slice(2).includes('--self-test') ? runSelfTest() : main())
}
