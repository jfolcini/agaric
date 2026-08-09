#!/usr/bin/env node
// #3492/#3504 — the responder's rejection messages are prose strings that cross
// the Rust/TypeScript process boundary as free text, and are declared
// independently on each side:
//
//   * `PAIRING_PROOF_REQUIRED_MESSAGE` and `PEER_NOT_PAIRED_MESSAGE` in
//     `src-tauri/agaric-sync/src/sync_daemon/server.rs` — the texts
//     `Rejection::peer_message` puts on the wire, and (for the proof message,
//     since #3491) also raises on the rejecting device's own event sink via
//     `Rejection::user_facing_message`.
//   * the same two names in `src/lib/pairing-rejections.ts` — where
//     `isPairingWindowRejection` reads both to keep a pairing-window refusal
//     out of the red "Sync failed" toast (#3505), and from where
//     `src/components/dialogs/PairingDialog.tsx` imports the proof message to
//     abandon a joiner's wait and say "wrong code".
//
// Nothing connects them. The messages travel inside a generic
// `SyncEvent::Error { message }`, so neither `cargo check` nor `tsc` can see
// the dependency, and neither side's tests notice a reword: the Rust tests
// assert against the Rust constants, the TS tests feed the frontend literals
// they own. Reword a Rust string — even as a pure copy improvement — and every
// test on both sides stays green while the dialog silently loses its failure
// path (degrading to a five-minute timeout that blames an expired code for what
// was a wrong one), and the toast suppression silently stops suppressing.
//
// This guard makes that reword red, on the commit that causes it. Its
// prek.toml `files` pattern names ALL THREE files (and this script), because a
// cross-check that watches only one of the things it compares never fires on a
// change to the others — the #3619 bug.
//
// ─── What is checked, per constant, and why none of it is redundant ───────
//
//   1. Declared on both sides. A missing declaration is a FAILURE, not a
//      vacuous pass: if an anchor is renamed or refactored away, this script
//      has fallen out of step with the repo and must say so rather than
//      reporting "nothing to compare, all good" forever.
//   2. The two values agree, byte for byte. This is the drift the issue is
//      about.
//   3. The Rust wire arm actually USES the constant
//      (`Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE`). A
//      constant can sit there, correct and agreeing, while the match arm
//      re-inlines a different literal — then the wire says one thing and the
//      guard compares another.
//   4. `isPairingWindowRejection` actually READS the constant
//      (`.includes(NAME)` in the declaring module). Same failure in the other
//      direction: an exported constant nothing reads is decoration, and
//      checks 1-2 would pass over a re-inlined, already-drifted matcher.
//   5. For `PAIRING_PROOF_REQUIRED_MESSAGE` only: the dialog's own matcher
//      reads it (`syncError.includes(...)` in PairingDialog.tsx). This is a
//      SEPARATE consumer with a separate job — it decides a pairing has
//      failed, where check 4's consumer only decides whether to toast — so
//      check 4 passing says nothing about it.
//
//      There is deliberately no equivalent for `PEER_NOT_PAIRED_MESSAGE`. The
//      dialog must NOT treat it as a terminal pairing failure: while a pairing
//      window is open the daemon dials every discovered *unpaired* peer, so it
//      is the ordinary reply from every third device on the LAN, and acting on
//      it would break pairing a third device into an existing pair. See
//      `isPairingWindowRejection`'s doc comment.
//
// Checks 3-5 are what stop this from becoming a guard whose condition cannot be
// reached — it is not enough that two declarations agree if neither is the
// thing on the wire.
//
// Deliberately textual rather than generated. Making the strings
// tauri-specta-exported bindings would remove the duplication outright, but
// they are not command signatures or types — they are strings inside a generic
// error payload, and there is no existing codegen channel for "a constant".
// The stronger option (a typed error discriminant on the wire) has been
// considered twice and not taken; #3504 is the second time.
//
// Usage:
//   node scripts/check-pairing-rejection-contract.mjs
//   node scripts/check-pairing-rejection-contract.mjs --self-test
//
// Exit codes: 0 = every constant agrees and is load-bearing; 1 = a real
// disagreement (or the wiring guard above); 2 = self-test failure.

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const RUST_PATH = join(REPO_ROOT, 'src-tauri', 'agaric-sync', 'src', 'sync_daemon', 'server.rs')
/** Where BOTH TypeScript constants are declared, and where check 4's reader lives. */
const TS_DECL_PATH = join(REPO_ROOT, 'src', 'lib', 'pairing-rejections.ts')
/** Check 5's second, independent consumer. */
const TSX_MATCHER_PATH = join(REPO_ROOT, 'src', 'components', 'dialogs', 'PairingDialog.tsx')

/**
 * The constants under contract. Same name on each side on purpose: grep finds
 * both.
 *
 * `rustVariant` is the `Rejection` arm the constant must be the value of, and
 * `readByDialog` records whether `PairingDialog.tsx` is a second consumer —
 * see check 5 above for why exactly one constant has it.
 */
const CONTRACT = [
  {
    name: 'PAIRING_PROOF_REQUIRED_MESSAGE',
    rustVariant: 'PairingProofMissing',
    readByDialog: true,
  },
  {
    name: 'PEER_NOT_PAIRED_MESSAGE',
    rustVariant: 'Unpaired',
    readByDialog: false,
  },
]

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * `pub const <NAME>: &str = "…";` from server.rs, or `null` when it is not
 * declared at all.
 *
 * Anchored at line start (with optional indentation) so the identical text
 * quoted inside a doc comment — that file is heavily commented, and the
 * comments name the constants repeatedly — cannot be mistaken for the
 * declaration.
 */
export function extractRustConst(text, name) {
  const m = text.match(new RegExp(`^\\s*pub const ${name}: &str = "([^"]*)";`, 'm'))
  return m ? m[1] : null
}

/**
 * `export const <NAME> = '…'` from the TypeScript declaring module, or `null`
 * when it is not declared. Accepts single quotes, double quotes or backticks
 * (no interpolation) so a formatter's quote-style choice is not a false
 * failure; a template literal containing `${` is rejected, because this scanner
 * cannot evaluate it and must not guess.
 */
export function extractTsConst(text, name) {
  const m = text.match(
    new RegExp(`^\\s*(?:export\\s+)?const ${name}\\s*=\\s*(['"\`])([^'"\`]*)\\1`, 'm'),
  )
  return m ? m[2] : null
}

/**
 * Does `pattern` match anywhere in `text` that is *live code* — i.e. not inside
 * a `//`/`///` line comment or on a `*` continuation line of a block comment?
 *
 * Every "is the constant actually used" check below needs this. They look for a
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
 * Does the Rust arm for `variant` resolve to `name`, rather than re-inlining a
 * literal? Tolerates a `Self::`/`Rejection::` prefix and any whitespace/line
 * wrapping rustfmt might choose. Commented-out arms do not count — see
 * [`matchesLiveCode`].
 */
export function rustArmUsesConst(text, { name, rustVariant }) {
  return matchesLiveCode(text, `(?:Self|Rejection)::${rustVariant}\\s*=>\\s*${name}\\b`)
}

/**
 * Does some matcher in `text` read the constant, rather than a literal? Matches
 * `.includes(NAME)` on any subject, so renaming the variable being tested is
 * not a false failure. Commented-out matchers do not count — see
 * [`matchesLiveCode`].
 */
export function tsMatcherUsesConst(text, name) {
  return matchesLiveCode(text, `\\.includes\\(\\s*${name}\\s*\\)`)
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Returns an array of human-readable problem strings — empty means the
 * contract holds. `state` is one entry per [`CONTRACT`] row.
 */
export function checkContract(states) {
  const problems = []

  for (const { name, readByDialog, rustValue, tsValue, rustUses, declUses, dialogUses } of states) {
    if (rustValue === null) {
      problems.push(
        `no \`pub const ${name}: &str = "…";\` found in src-tauri/agaric-sync/src/sync_daemon/server.rs — ` +
          'either the constant was renamed/removed (update this guard, or delete it if the ' +
          'contract is gone) or the declaration changed shape. Not treated as "nothing to ' +
          'check": a guard that passes because it found nothing is worse than no guard.',
      )
    }
    if (tsValue === null) {
      problems.push(
        `no \`const ${name} = '…'\` found in src/lib/pairing-rejections.ts — ` +
          'same reasoning as the Rust side above.',
      )
    }
    if (rustValue === null || tsValue === null) continue

    if (rustValue !== tsValue) {
      problems.push(
        `${name} has drifted across the Rust/TypeScript boundary:\n` +
          `      - src-tauri/agaric-sync/src/sync_daemon/server.rs: ${JSON.stringify(rustValue)}\n` +
          `      - src/lib/pairing-rejections.ts:                   ${JSON.stringify(tsValue)}\n` +
          '    The frontend matches the backend message as a SUBSTRING of a generic sync error, so ' +
          'these must agree byte for byte. If the Rust wording changed on purpose, copy it to the ' +
          'TS constant (and check the tests that feed the frontend this string by hand).',
      )
    }

    if (!rustUses) {
      problems.push(
        `\`Rejection::peer_message\` does not resolve its arm to ${name} — ` +
          'the constant agrees with the frontend but is not what goes on the wire, so this guard ' +
          'would be comparing a value nothing sends.',
      )
    }
    if (!declUses) {
      problems.push(
        `src/lib/pairing-rejections.ts has no \`.includes(${name})\` — the constant is declared ` +
          'but `isPairingWindowRejection` reads something else (most likely a re-inlined literal), ' +
          'so this guard would be comparing a value nothing matches.',
      )
    }
    if (readByDialog && !dialogUses) {
      problems.push(
        `src/components/dialogs/PairingDialog.tsx has no \`.includes(${name})\` — the dialog's ` +
          'failure path is a SECOND consumer with a different job (it decides a pairing failed, ' +
          'not merely whether to toast), so the check above does not cover it. Without this the ' +
          "joiner's wait falls through to a five-minute timeout that blames an expired code.",
      )
    }
  }

  return problems
}

/** Throws with every problem spelled out, or returns the extracted state. */
export function assertPairingRejectionContract({
  rustPath = RUST_PATH,
  tsDeclPath = TS_DECL_PATH,
  tsxMatcherPath = TSX_MATCHER_PATH,
} = {}) {
  const rustText = readFileSync(rustPath, 'utf8')
  const declText = readFileSync(tsDeclPath, 'utf8')
  const dialogText = readFileSync(tsxMatcherPath, 'utf8')
  const states = CONTRACT.map((entry) => ({
    ...entry,
    rustValue: extractRustConst(rustText, entry.name),
    tsValue: extractTsConst(declText, entry.name),
    rustUses: rustArmUsesConst(rustText, entry),
    declUses: tsMatcherUsesConst(declText, entry.name),
    dialogUses: tsMatcherUsesConst(dialogText, entry.name),
  }))
  const problems = checkContract(states)
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-pairing-rejection-contract.mjs found the rejection-message contract broken (#3492, #3504):\n  - ${problems.join('\n  - ')}`,
    )
  }
  return states
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const states = assertPairingRejectionContract()
  const summary = states.map((s) => `${s.name}=${JSON.stringify(s.rustValue)}`).join(', ')
  console.log(
    `OK  rejection-message contract: server.rs, pairing-rejections.ts and PairingDialog.tsx agree, and every constant is load-bearing (${summary})`,
  )
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

const RUST_FIXTURE = [
  '/// Doc comment mentioning PAIRING_PROOF_REQUIRED_MESSAGE and even the raw',
  '/// text "a decoy value" so the extractor cannot be fooled by prose.',
  'pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "pairing passphrase proof required";',
  'pub const PEER_NOT_PAIRED_MESSAGE: &str = "peer not paired with this device";',
  '',
  'impl Rejection {',
  "    pub fn peer_message(&self) -> &'static str {",
  '        match self {',
  '            Self::Unpaired => PEER_NOT_PAIRED_MESSAGE,',
  '            Self::PairingProofMissing => PAIRING_PROOF_REQUIRED_MESSAGE,',
  '        }',
  '    }',
  '}',
  '',
].join('\n')

const DECL_FIXTURE = [
  "// A comment quoting 'a decoy value' to prove prose is not extracted.",
  "export const PAIRING_PROOF_REQUIRED_MESSAGE = 'pairing passphrase proof required'",
  "export const PEER_NOT_PAIRED_MESSAGE = 'peer not paired with this device'",
  '',
  'export function isPairingWindowRejection(message: string): boolean {',
  '  return (',
  '    message.includes(PAIRING_PROOF_REQUIRED_MESSAGE) || message.includes(PEER_NOT_PAIRED_MESSAGE)',
  '  )',
  '}',
  '',
].join('\n')

const DIALOG_FIXTURE = [
  "import { PAIRING_PROOF_REQUIRED_MESSAGE } from '@/lib/pairing-rejections'",
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

const PROOF = CONTRACT[0]
const UNPAIRED = CONTRACT[1]

function selfTestExtraction({ check }) {
  check(
    extractRustConst(RUST_FIXTURE, PROOF.name) === 'pairing passphrase proof required',
    'the Rust constant value is extracted verbatim, ignoring the same words in doc prose',
    JSON.stringify(extractRustConst(RUST_FIXTURE, PROOF.name)),
  )
  check(
    extractRustConst(RUST_FIXTURE, UNPAIRED.name) === 'peer not paired with this device',
    'the SECOND Rust constant is extracted independently of the first',
    JSON.stringify(extractRustConst(RUST_FIXTURE, UNPAIRED.name)),
  )
  check(
    extractRustConst('// pub const PAIRING_PROOF_REQUIRED_MESSAGE: &str = "x";\n', PROOF.name) ===
      null,
    'a commented-out Rust declaration is not extracted as the live one',
    '',
  )
  check(
    extractRustConst('fn main() {}\n', PROOF.name) === null,
    'a file with no Rust declaration → null',
    '',
  )

  check(
    extractTsConst(DECL_FIXTURE, PROOF.name) === 'pairing passphrase proof required',
    'the TS constant value is extracted verbatim, ignoring quoted prose in comments',
    JSON.stringify(extractTsConst(DECL_FIXTURE, PROOF.name)),
  )
  check(
    extractTsConst(DECL_FIXTURE, UNPAIRED.name) === 'peer not paired with this device',
    'the SECOND TS constant is extracted independently of the first',
    JSON.stringify(extractTsConst(DECL_FIXTURE, UNPAIRED.name)),
  )
  check(
    extractTsConst('const PAIRING_PROOF_REQUIRED_MESSAGE = "double quoted"\n', PROOF.name) ===
      'double quoted',
    'a double-quoted TS declaration is read (formatter quote style is not a failure)',
    '',
  )
  check(
    extractTsConst("// const PAIRING_PROOF_REQUIRED_MESSAGE = 'x'\n", PROOF.name) === null,
    'a commented-out TS declaration is not extracted as the live one',
    '',
  )
  check(
    extractTsConst('export const OTHER = 1\n', PROOF.name) === null,
    'a file with no TS declaration → null',
    '',
  )

  check(rustArmUsesConst(RUST_FIXTURE, PROOF), 'the Rust arm is seen resolving to the constant', '')
  check(
    rustArmUsesConst(RUST_FIXTURE, UNPAIRED),
    "the SECOND constant's arm is checked against its OWN variant, not the first's",
    '',
  )
  check(
    !rustArmUsesConst(RUST_FIXTURE.replace(LIVE_RUST_ARM, INLINED_RUST_ARM), PROOF),
    'a re-inlined literal in the Rust match arm is NOT mistaken for a constant reference',
    '',
  )
  check(
    !rustArmUsesConst(RUST_FIXTURE, { name: PROOF.name, rustVariant: 'Unpaired' }),
    'the arm check is variant-specific: the proof constant on the Unpaired arm is not a match',
    '',
  )
  check(tsMatcherUsesConst(DECL_FIXTURE, PROOF.name), 'the TS matcher is seen reading it', '')
  check(
    !tsMatcherUsesConst(DECL_FIXTURE.replace(LIVE_TS_MATCHER, INLINED_TS_MATCHER), PROOF.name),
    'a re-inlined literal in the TS matcher is NOT mistaken for a constant reference',
    '',
  )

  // The re-inlining above, done the way a human actually does it: the old line
  // is left behind commented out. An unanchored `.test()` reads the comment as
  // the live reference and the whole "is it load-bearing" check goes vacuous.
  check(
    !rustArmUsesConst(
      RUST_FIXTURE.replace(LIVE_RUST_ARM, `// ${LIVE_RUST_ARM}\n            ${INLINED_RUST_ARM}`),
      PROOF,
    ),
    'a COMMENTED-OUT Rust arm does not satisfy the constant-reference check',
    '',
  )
  check(
    !tsMatcherUsesConst(
      `${DECL_FIXTURE.replace(LIVE_TS_MATCHER, INLINED_TS_MATCHER)}\n// if (!syncError${LIVE_TS_MATCHER}) return\n`,
      PROOF.name,
    ),
    'a COMMENTED-OUT TS matcher does not satisfy the constant-reference check',
    '',
  )
  check(
    !rustArmUsesConst(
      `${RUST_FIXTURE.replace(LIVE_RUST_ARM, INLINED_RUST_ARM)}\n/// * \`${LIVE_RUST_ARM}\` is the wire arm.\n`,
      PROOF,
    ),
    'a DOC-COMMENT mention of the arm does not satisfy the constant-reference check',
    '',
  )

  // …and the tolerance the anchoring must not cost: rustfmt may wrap the arm.
  check(
    rustArmUsesConst(
      RUST_FIXTURE.replace(
        LIVE_RUST_ARM,
        'Self::PairingProofMissing =>\n                PAIRING_PROOF_REQUIRED_MESSAGE,',
      ),
      PROOF,
    ),
    'a rustfmt-wrapped arm is still recognised (the comment check must not over-anchor)',
    '',
  )
}

/** A healthy state row for `entry`, which individual assertions then spoil. */
function healthyState(entry, value) {
  return {
    ...entry,
    rustValue: value,
    tsValue: value,
    rustUses: true,
    declUses: true,
    dialogUses: entry.readByDialog,
  }
}

function selfTestContract({ check }) {
  const proof = healthyState(PROOF, 'pairing passphrase proof required')
  const unpaired = healthyState(UNPAIRED, 'peer not paired with this device')
  const healthy = [proof, unpaired]
  check(checkContract(healthy).length === 0, 'an agreeing, load-bearing pair passes', '')

  // The drift class #3492 is about, in both directions and on both constants.
  for (const [label, spoiled] of [
    ['a REWORDED Rust message with an unchanged TS constant', { ...proof, rustValue: 'needed' }],
    ['a REWORDED TS constant with an unchanged Rust message', { ...proof, tsValue: 'needed' }],
    ['the SECOND constant drifting', { ...unpaired, tsValue: 'not paired' }],
  ]) {
    const problems = checkContract([spoiled])
    check(
      problems.length === 1 && problems[0].includes('drifted'),
      `${label} is caught`,
      JSON.stringify(problems),
    )
  }

  // Anchors disappearing must fail, not pass vacuously.
  check(
    checkContract([{ ...proof, rustValue: null }]).length === 1,
    'a missing Rust declaration is a failure, not a vacuous pass',
    '',
  )
  check(
    checkContract([{ ...proof, tsValue: null }]).length === 1,
    'a missing TS declaration is a failure, not a vacuous pass',
    '',
  )

  // Constants that agree but are not the ones on the wire / in a matcher.
  check(
    checkContract([{ ...proof, rustUses: false }]).length === 1,
    'an agreeing Rust constant the wire arm does not use is caught',
    '',
  )
  check(
    checkContract([{ ...proof, declUses: false }]).length === 1,
    'an agreeing constant `isPairingWindowRejection` does not read is caught',
    '',
  )
  check(
    checkContract([{ ...proof, dialogUses: false }]).length === 1,
    "an agreeing constant the DIALOG's failure path does not read is caught",
    '',
  )
  // …and the asymmetry that is deliberate: the dialog must NOT match the
  // unpaired message, so its absence there is not a problem. A guard that
  // demanded it would push the frontend into the #3504 regression this whole
  // contract documents.
  check(
    checkContract([{ ...unpaired, dialogUses: false }]).length === 0,
    'PEER_NOT_PAIRED_MESSAGE is deliberately NOT required in the dialog (see #3504)',
    '',
  )
}

/** End-to-end against fixture files on disk, then against the real repo. */
function selfTestEndToEnd({ check, fail }) {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-rejection-contract-'))
  const rustPath = join(dir, 'server.rs')
  const tsDeclPath = join(dir, 'pairing-rejections.ts')
  const tsxMatcherPath = join(dir, 'PairingDialog.tsx')
  const paths = { rustPath, tsDeclPath, tsxMatcherPath }
  writeFileSync(rustPath, RUST_FIXTURE, 'utf8')
  writeFileSync(tsDeclPath, DECL_FIXTURE, 'utf8')
  writeFileSync(tsxMatcherPath, DIALOG_FIXTURE, 'utf8')

  let threw = null
  try {
    assertPairingRejectionContract(paths)
  } catch (err) {
    threw = err
  }
  check(threw === null, 'end-to-end: an agreeing fixture set does not throw', threw?.message)

  // Reword ONLY the Rust side on disk — the exact move #3492 describes.
  writeFileSync(
    rustPath,
    RUST_FIXTURE.replaceAll('pairing passphrase proof required', 'wrong pairing code'),
    'utf8',
  )
  threw = null
  try {
    assertPairingRejectionContract(paths)
  } catch (err) {
    threw = err
  }
  check(
    threw !== null && threw.message.includes('wrong pairing code'),
    'end-to-end: rewording the Rust message alone DOES throw, quoting both values',
    threw?.message ?? '(no throw)',
  )

  // …and the #3504 half: rewording the OTHER message, which only the toast
  // suppression reads, must be just as red. It is the message no test on
  // either side asserts by hand, so this guard is the only thing watching it.
  writeFileSync(rustPath, RUST_FIXTURE, 'utf8')
  writeFileSync(
    tsDeclPath,
    DECL_FIXTURE.replaceAll('peer not paired with this device', 'peer is not paired'),
    'utf8',
  )
  threw = null
  try {
    assertPairingRejectionContract(paths)
  } catch (err) {
    threw = err
  }
  check(
    threw !== null && threw.message.includes('peer is not paired'),
    'end-to-end: rewording the unpaired message alone DOES throw too',
    threw?.message ?? '(no throw)',
  )

  // …and the real repo, as it stands right now, must satisfy the contract.
  try {
    const states = assertPairingRejectionContract()
    check(true, `the real repo satisfies the contract (${states.length} constants)`, '')
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
