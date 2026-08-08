#!/usr/bin/env node
// #3492 — the pairing-proof rejection message is a prose string that crosses
// the Rust/TypeScript process boundary as free text, and is declared
// independently on each side:
//
//   * `PAIRING_PROOF_REQUIRED_MESSAGE` in
//     `src-tauri/agaric-sync/src/sync_daemon/server.rs` — the text the #855
//     proof gate puts on the wire (`Rejection::peer_message`) and, since
//     #3491, also raises on the rejecting device's own event sink
//     (`Rejection::user_facing_message`).
//   * `PAIRING_PROOF_REQUIRED_MESSAGE` in
//     `src/components/dialogs/PairingDialog.tsx` — the text the joiner's
//     dialog matches (`syncError.includes(...)`) to abandon its wait and say
//     "wrong code".
//
// Nothing connects them. The message travels inside a generic
// `SyncEvent::Error { message }`, so neither `cargo check` nor `tsc` can see
// the dependency, and neither side's tests notice a reword: the Rust tests
// assert against the Rust constant, the TSX tests feed the dialog a literal
// they own. Reword the Rust string — even as a pure copy improvement — and
// every test on both sides stays green while the dialog silently loses its
// failure path and degrades to a five-minute timeout that blames an expired
// code for what was a wrong one.
//
// This guard makes that reword red, on the commit that causes it. Its
// prek.toml `files` pattern names BOTH files (and this script), because a
// cross-check that watches only one of the two things it compares never fires
// on a change to the other — the #3619 bug.
//
// ─── What is checked, and why each check is not redundant ────────────────
//
//   1. Both constants are declared. A missing declaration is a FAILURE, not
//      a vacuous pass: if either anchor is renamed or refactored away, this
//      script has fallen out of step with the repo and must say so rather
//      than reporting "nothing to compare, all good" forever.
//   2. Their values agree, byte for byte. This is the drift the issue is
//      about.
//   3. The Rust wire arm actually USES the constant
//      (`Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE`). A
//      constant can sit there, correct and agreeing, while the match arm
//      re-inlines a different literal — then the wire says one thing and the
//      guard compares another.
//   4. The TSX matcher actually USES the constant
//      (`syncError.includes(PAIRING_PROOF_REQUIRED_MESSAGE)`). Same failure
//      in the other direction: an exported constant nothing reads is
//      decoration, and checks 1-2 would pass over a re-inlined,
//      already-drifted `.includes('...')`.
//
// Checks 3 and 4 are what stop this from becoming a guard whose condition
// cannot be reached — it is not enough that two declarations agree if
// neither is the thing on the wire.
//
// Deliberately textual rather than generated. Making the string a
// tauri-specta-exported binding would remove the duplication outright, but
// the value is not a command signature or a type — it is one string inside a
// generic error payload, and there is no existing codegen channel for "a
// constant". See this PR's report for the stronger option (a typed error
// discriminant on the wire) that was considered and not taken.
//
// Usage:
//   node scripts/check-pairing-rejection-contract.mjs
//   node scripts/check-pairing-rejection-contract.mjs --self-test
//
// Exit codes: 0 = the two sides agree and both are load-bearing; 1 = a real
// disagreement (or the wiring guard above); 2 = self-test failure.

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const RUST_PATH = join(REPO_ROOT, 'src-tauri', 'agaric-sync', 'src', 'sync_daemon', 'server.rs')
const TSX_PATH = join(REPO_ROOT, 'src', 'components', 'dialogs', 'PairingDialog.tsx')

/** The name both sides give the constant. Same name on purpose: grep finds both. */
const CONST_NAME = 'PAIRING_PROOF_REQUIRED_MESSAGE'

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * `pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "…";` from server.rs, or
 * `null` when it is not declared at all.
 *
 * Anchored at line start (with optional indentation) so the identical text
 * quoted inside a doc comment — this file is heavily commented, and the
 * comments name the constant repeatedly — cannot be mistaken for the
 * declaration.
 */
export function extractRustConst(text) {
  const m = text.match(new RegExp(`^\\s*pub const ${CONST_NAME}: &str = "([^"]*)";`, 'm'))
  return m ? m[1] : null
}

/**
 * `export const PAIRING_PROOF_REQUIRED_MESSAGE = '…'` from PairingDialog.tsx,
 * or `null` when it is not declared. Accepts single quotes, double quotes or
 * backticks (no interpolation) so a formatter's quote-style choice is not a
 * false failure; a template literal containing `${` is rejected, because this
 * scanner cannot evaluate it and must not guess.
 */
export function extractTsConst(text) {
  const m = text.match(
    new RegExp(`^\\s*(?:export\\s+)?const ${CONST_NAME}\\s*=\\s*(['"\`])([^'"\`]*)\\1`, 'm'),
  )
  return m ? m[2] : null
}

/**
 * Does `pattern` match anywhere in `text` that is *live code* — i.e. not inside
 * a `//`/`///` line comment or on a `*` continuation line of a block comment?
 *
 * Both "is the constant actually used" checks below need this. They look for a
 * short code shape anywhere in a large file, and the single most likely artifact
 * of exactly the edit they exist to catch — re-inlining the literal — is the
 * previous line left behind, commented out. An unanchored `.test()` reads that
 * commented-out line as the live reference and passes, so the check that is
 * supposed to stop the guard becoming vacuous would itself be vacuous.
 *
 * Only the line the match *starts* on is inspected, so rustfmt wrapping the arm
 * across lines is still recognised.
 */
function matchesLiveCode(text, source) {
  for (const m of text.matchAll(new RegExp(source, 'g'))) {
    const linePrefix = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index)
    if (!linePrefix.includes('//') && !/^\s*\*/.test(linePrefix)) return true
  }
  return false
}

/**
 * Does the Rust `PairingProofMissing` wire arm resolve to the constant, rather
 * than re-inlining a literal? Tolerates a `Self::`/`Rejection::` prefix and
 * any whitespace/line wrapping rustfmt might choose. Commented-out arms do not
 * count — see [`matchesLiveCode`].
 */
export function rustArmUsesConst(text) {
  return matchesLiveCode(text, `(?:Self|Rejection)::PairingProofMissing\\s*=>\\s*${CONST_NAME}\\b`)
}

/**
 * Does the dialog's matcher read the constant, rather than a literal? Matches
 * `.includes(PAIRING_PROOF_REQUIRED_MESSAGE)` on any subject, so renaming
 * `syncError` is not a false failure. Commented-out matchers do not count —
 * see [`matchesLiveCode`].
 */
export function tsMatcherUsesConst(text) {
  return matchesLiveCode(text, `\\.includes\\(\\s*${CONST_NAME}\\s*\\)`)
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Returns an array of human-readable problem strings — empty means the
 * contract holds.
 */
export function checkContract({ rustValue, tsValue, rustUses, tsUses }) {
  const problems = []

  if (rustValue === null) {
    problems.push(
      `no \`pub const ${CONST_NAME}: &str = "…";\` found in src-tauri/agaric-sync/src/sync_daemon/server.rs — ` +
        'either the constant was renamed/removed (update this guard, or delete it if the ' +
        'contract is gone) or the declaration changed shape. Not treated as "nothing to ' +
        'check": a guard that passes because it found nothing is worse than no guard.',
    )
  }
  if (tsValue === null) {
    problems.push(
      `no \`const ${CONST_NAME} = '…'\` found in src/components/dialogs/PairingDialog.tsx — ` +
        'same reasoning as the Rust side above.',
    )
  }
  if (problems.length > 0) return problems

  if (rustValue !== tsValue) {
    problems.push(
      `the pairing-proof rejection message has drifted across the Rust/TypeScript boundary:\n` +
        `      - src-tauri/agaric-sync/src/sync_daemon/server.rs: ${JSON.stringify(rustValue)}\n` +
        `      - src/components/dialogs/PairingDialog.tsx:        ${JSON.stringify(tsValue)}\n` +
        '    The dialog matches the backend message as a SUBSTRING of a generic sync error, so ' +
        'these must agree byte for byte. If the Rust wording changed on purpose, copy it to the ' +
        'TSX constant (and check the tests that feed the dialog this string by hand).',
    )
  }

  if (!rustUses) {
    problems.push(
      `\`Rejection::peer_message\` does not resolve \`PairingProofMissing\` to ${CONST_NAME} — ` +
        'the constant agrees with the frontend but is not what goes on the wire, so this guard ' +
        'would be comparing a value nothing sends.',
    )
  }
  if (!tsUses) {
    problems.push(
      `PairingDialog.tsx has no \`.includes(${CONST_NAME})\` — the constant is declared but the ` +
        'matcher reads something else (most likely a re-inlined literal), so this guard would be ' +
        'comparing a value nothing matches.',
    )
  }

  return problems
}

/** Throws with every problem spelled out, or returns the extracted state. */
export function assertPairingRejectionContract({ rustPath = RUST_PATH, tsxPath = TSX_PATH } = {}) {
  const rustText = readFileSync(rustPath, 'utf8')
  const tsText = readFileSync(tsxPath, 'utf8')
  const state = {
    rustValue: extractRustConst(rustText),
    tsValue: extractTsConst(tsText),
    rustUses: rustArmUsesConst(rustText),
    tsUses: tsMatcherUsesConst(tsText),
  }
  const problems = checkContract(state)
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-pairing-rejection-contract.mjs found the pairing-proof rejection contract broken (#3492):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return state
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { rustValue } = assertPairingRejectionContract()
  console.log(
    `OK  pairing-proof rejection contract: server.rs and PairingDialog.tsx both carry ${JSON.stringify(rustValue)}, and both are load-bearing`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

const RUST_FIXTURE = [
  '/// Doc comment mentioning PAIRING_PROOF_REQUIRED_MESSAGE and even the raw',
  '/// text "a decoy value" so the extractor cannot be fooled by prose.',
  'pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "pairing passphrase proof required";',
  '',
  'impl Rejection {',
  "    pub fn peer_message(&self) -> &'static str {",
  '        match self {',
  '            Self::Unpaired => "peer not paired with this device",',
  '            Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE,',
  '        }',
  '    }',
  '}',
  '',
].join('\n')

const TSX_FIXTURE = [
  "// A comment quoting 'a decoy value' to prove prose is not extracted.",
  "export const PAIRING_PROOF_REQUIRED_MESSAGE = 'pairing passphrase proof required'",
  '',
  'useEffect(() => {',
  '  if (!syncError.includes(PAIRING_PROOF_REQUIRED_MESSAGE)) return',
  '}, [syncError])',
  '',
].join('\n')

// The healthy code shape on each side, and the drifted one the checks must
// reject. Named because several assertions below mutate the fixtures between
// exactly these two forms, and a typo in one copy would silently weaken the
// assertion that uses it.
const LIVE_RUST_ARM = 'Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE,'
const INLINED_RUST_ARM = 'Self::PairingProofMissing => "pairing passphrase proof required",'
const LIVE_TS_MATCHER = '.includes(PAIRING_PROOF_REQUIRED_MESSAGE)'
const INLINED_TS_MATCHER = ".includes('pairing passphrase proof required')"

function selfTestExtraction({ check }) {
  check(
    extractRustConst(RUST_FIXTURE) === 'pairing passphrase proof required',
    'the Rust constant value is extracted verbatim, ignoring the same words in doc prose',
    JSON.stringify(extractRustConst(RUST_FIXTURE)),
  )
  check(
    extractRustConst('// pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "x";\n') === null,
    'a commented-out Rust declaration is not extracted as the live one',
    JSON.stringify(extractRustConst('// pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "x";\n')),
  )
  check(extractRustConst('fn main() {}\n') === null, 'a file with no Rust declaration → null', '')

  check(
    extractTsConst(TSX_FIXTURE) === 'pairing passphrase proof required',
    'the TS constant value is extracted verbatim, ignoring quoted prose in comments',
    JSON.stringify(extractTsConst(TSX_FIXTURE)),
  )
  check(
    extractTsConst('const PAIRING_PROOF_REQUIRED_MESSAGE = "double quoted"\n') === 'double quoted',
    'a double-quoted TS declaration is read (formatter quote style is not a failure)',
    JSON.stringify(extractTsConst('const PAIRING_PROOF_REQUIRED_MESSAGE = "double quoted"\n')),
  )
  check(
    extractTsConst("// const PAIRING_PROOF_REQUIRED_MESSAGE = 'x'\n") === null,
    'a commented-out TS declaration is not extracted as the live one',
    JSON.stringify(extractTsConst("// const PAIRING_PROOF_REQUIRED_MESSAGE = 'x'\n")),
  )
  check(
    extractTsConst('export const OTHER = 1\n') === null,
    'a file with no TS declaration → null',
    '',
  )

  check(rustArmUsesConst(RUST_FIXTURE), 'the Rust match arm is seen resolving to the constant', '')
  check(
    !rustArmUsesConst(RUST_FIXTURE.replace(LIVE_RUST_ARM, INLINED_RUST_ARM)),
    'a re-inlined literal in the Rust match arm is NOT mistaken for a constant reference',
    '',
  )
  check(tsMatcherUsesConst(TSX_FIXTURE), 'the TS matcher is seen reading the constant', '')
  check(
    !tsMatcherUsesConst(TSX_FIXTURE.replace(LIVE_TS_MATCHER, INLINED_TS_MATCHER)),
    'a re-inlined literal in the TS matcher is NOT mistaken for a constant reference',
    '',
  )

  // The re-inlining above, done the way a human actually does it: the old line
  // is left behind commented out. An unanchored `.test()` reads the comment as
  // the live reference and the whole "is it load-bearing" check goes vacuous.
  check(
    !rustArmUsesConst(
      RUST_FIXTURE.replace(LIVE_RUST_ARM, `// ${LIVE_RUST_ARM}\n            ${INLINED_RUST_ARM}`),
    ),
    'a COMMENTED-OUT Rust arm does not satisfy the constant-reference check',
    '',
  )
  check(
    !tsMatcherUsesConst(
      `${TSX_FIXTURE.replace(LIVE_TS_MATCHER, INLINED_TS_MATCHER)}\n// if (!syncError${LIVE_TS_MATCHER}) return\n`,
    ),
    'a COMMENTED-OUT TS matcher does not satisfy the constant-reference check',
    '',
  )
  check(
    !rustArmUsesConst(
      `${RUST_FIXTURE.replace(LIVE_RUST_ARM, INLINED_RUST_ARM)}\n/// * \`${LIVE_RUST_ARM}\` is the wire arm.\n`,
    ),
    'a DOC-COMMENT mention of the arm does not satisfy the constant-reference check',
    '',
  )

  // …and the tolerance the anchoring must not cost: rustfmt may wrap the arm.
  check(
    rustArmUsesConst(
      RUST_FIXTURE.replace(
        'Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE,',
        'Self::PairingProofMissing =>\n                PAIRING_PROOF_REQUIRED_MESSAGE,',
      ),
    ),
    'a rustfmt-wrapped arm is still recognised (the comment check must not over-anchor)',
    '',
  )
}

function selfTestContract({ check }) {
  const healthy = {
    rustValue: 'pairing passphrase proof required',
    tsValue: 'pairing passphrase proof required',
    rustUses: true,
    tsUses: true,
  }
  check(checkContract(healthy).length === 0, 'an agreeing, load-bearing pair passes', '')

  // The drift class #3492 is about, in both directions.
  {
    const problems = checkContract({ ...healthy, rustValue: 'pairing passphrase proof needed' })
    check(
      problems.length === 1 && problems[0].includes('drifted'),
      'a REWORDED Rust message with an unchanged TS matcher is caught',
      JSON.stringify(problems),
    )
  }
  {
    const problems = checkContract({ ...healthy, tsValue: 'pairing passphrase proof needed' })
    check(
      problems.length === 1 && problems[0].includes('drifted'),
      'a REWORDED TS matcher with an unchanged Rust message is caught',
      JSON.stringify(problems),
    )
  }

  // Anchors disappearing must fail, not pass vacuously.
  check(
    checkContract({ ...healthy, rustValue: null }).length === 1,
    'a missing Rust declaration is a failure, not a vacuous pass',
    '',
  )
  check(
    checkContract({ ...healthy, tsValue: null }).length === 1,
    'a missing TS declaration is a failure, not a vacuous pass',
    '',
  )

  // Constants that agree but are not the ones on the wire / in the matcher.
  check(
    checkContract({ ...healthy, rustUses: false }).length === 1,
    'an agreeing Rust constant the wire arm does not use is caught',
    '',
  )
  check(
    checkContract({ ...healthy, tsUses: false }).length === 1,
    'an agreeing TS constant the matcher does not use is caught',
    '',
  )
}

/** End-to-end against fixture files on disk, then against the real repo. */
function selfTestEndToEnd({ check, fail }) {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-rejection-contract-'))
  const rustPath = join(dir, 'server.rs')
  const tsxPath = join(dir, 'PairingDialog.tsx')
  writeFileSync(rustPath, RUST_FIXTURE, 'utf8')
  writeFileSync(tsxPath, TSX_FIXTURE, 'utf8')

  let threw = null
  try {
    assertPairingRejectionContract({ rustPath, tsxPath })
  } catch (err) {
    threw = err
  }
  check(threw === null, 'end-to-end: an agreeing fixture pair does not throw', threw?.message)

  // Reword ONLY the Rust side on disk — the exact move #3492 describes.
  writeFileSync(
    rustPath,
    RUST_FIXTURE.replaceAll('pairing passphrase proof required', 'wrong pairing code'),
    'utf8',
  )
  threw = null
  try {
    assertPairingRejectionContract({ rustPath, tsxPath })
  } catch (err) {
    threw = err
  }
  check(
    threw !== null && threw.message.includes('wrong pairing code'),
    'end-to-end: rewording the Rust message alone DOES throw, quoting both values',
    threw?.message ?? '(no throw)',
  )

  // …and the real repo, as it stands right now, must satisfy the contract.
  try {
    const { rustValue } = assertPairingRejectionContract()
    check(true, `the real repo satisfies the contract (${JSON.stringify(rustValue)})`, '')
  } catch (err) {
    fail('the real repo satisfies the contract', err.message)
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
  selfTestContract({ check })
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
      console.error(`check-pairing-rejection-contract: ${err.message}`)
      process.exit(1)
    }
  }
}
