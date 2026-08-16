#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// WDIO browser-download gate (#3972 / Dependabot alert #50).
//
// Alert #50: `extract-zip` <= 2.0.1 — unvalidated symlink path traversal
// during archive extraction (CVE-2026-56876, GHSA-x7jf-2287-qcpf), HIGH,
// dev scope, and **no patched version exists** (2.0.1 is the latest
// release). It reaches this repo only transitively:
//
//     @wdio/cli → @wdio/utils → @puppeteer/browsers → extract-zip
//
// The alert is dismissed as unreachable. This guard is what makes that
// dismissal an enforced property instead of a sentence in an issue.
//
// ─── What actually keeps it unreachable (verified in node_modules) ───
//
// `extract-zip` is only ever called from `unpackArchive()` in
// `@puppeteer/browsers/lib/esm/fileUtil.js`, behind a lazy
// `await import('extract-zip')` taken only for a `.zip` archive. The
// only thing in this repo that can reach `unpackArchive` is
// `setupPuppeteerBrowser()` in `@wdio/utils/build/node.js` — i.e. WDIO
// downloading and unpacking a browser build for you.
//
// Two INDEPENDENT properties of `wdio.conf.ts` keep that from happening,
// and both are checked here:
//
//   1. No `browserName` capability. `@wdio/cli`'s launcher calls
//      `setupDriver(config, caps)` and `setupBrowser(config, caps)`
//      UNCONDITIONALLY on every run. Both funnel through
//      `mapCapabilities()` (`@wdio/utils/build/node.js`), whose filter
//      keeps a capability only when `cap.browserName` is truthy. Our
//      single capability carries `tauri:options` and nothing else, so the
//      list is empty and both functions return without downloading.
//
//   2. Remote-driver options. That same filter also requires
//      `!definesRemoteDriver(options)`, and `definesRemoteDriver`
//      (`@wdio/utils/build/index.js`) is true on `Boolean(options.port)`
//      alone. `wdio.conf.ts` sets `port: 4444` (and a non-default
//      `hostname`), pointing at the `tauri-driver` the config spawns
//      itself. The same predicate gates the session-start path:
//      `startWebDriver()` returns early instead of dynamically importing
//      `./node.js` and starting a local driver.
//
// Either property alone is sufficient today. The guard requires BOTH,
// because losing one leaves a config one edit away from downloading and
// unpacking a browser archive through the vulnerable code — and the
// remaining property would then be load-bearing without anybody having
// decided that.
//
// ─── Correction to #3972 ─────────────────────────────────────────────
//
// #3972 states that `@wdio/utils/build/node.js` is reached only through
// the dynamic `import('./node.js')` inside `startWebDriver`, and that the
// vulnerable code is therefore "never loaded". That is not right:
// `@wdio/cli/build/index.js` STATICALLY imports `{ setupDriver,
// setupBrowser }` from `@wdio/utils/node`, so `node.js` — and with it
// `@puppeteer/browsers` — is loaded into every `wdio run` process. What
// is never reached is the *download and unpack*, and it is the
// `mapCapabilities` filter above, not the `startWebDriver` early return,
// that stops it. The conclusion (unreachable) survives; the stated
// mechanism did not, which is exactly why it is checked here in code.
//
// Usage: node scripts/check-wdio-driver-gate.mjs
//        node scripts/check-wdio-driver-gate.mjs --conf <path>
//        node scripts/check-wdio-driver-gate.mjs --self-test
// Exit:  0 = both gates hold, 1 = a gate is gone (re-evaluate alert #50),
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findMatchingBracket, ScanError, stripComments, tokenize } from './lib/js-scanner.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const WDIO_CONF = 'wdio.conf.ts'

// Mirrors `@wdio/utils/build/index.js` — `definesRemoteDriver` compares
// against these, so a value EQUAL to the default does not satisfy the
// gate. Pinned as literals rather than read from node_modules on purpose:
// this guard must keep working in a checkout with no install, and a
// change to these values upstream should surface as a guard that no
// longer matches reality, not as a guard that silently agrees with it.
const DEFAULT_HOSTNAME = 'localhost'
const DEFAULT_PROTOCOL = 'http'
const DEFAULT_PATH = '/'

// ─── the scanner ─────────────────────────────────────────────────────
//
// Comment stripping comes from `scripts/lib/js-scanner.mjs`, the sanctioned
// implementation for JS-side guards (#3991). This guard used to carry its own
// `stripTsComments`: two `String.replace` passes with NO string-literal
// awareness. It failed OPEN (#3990 item 1). A block-comment opener inside a
// STRING, plus any block-comment terminator later in the file, blanked every
// line between them.
//
// Not hypothetical here. `wdio.conf.ts` already contains the glob
// `'./e2e-tauri/**` + `/*.e2e.ts'`, which the old pass matched as a comment —
// harmless only because that one self-terminates. Widen the glob to
// `'./e2e-tauri/**'` so its opener has no closer of its own, add any JSDoc
// block below `capabilities`, and the `browserName` line in between is blanked
// to spaces: the guard reported OK on a config that downloads a browser, which
// is the one thing it exists to notice.
//
// The shared scanner lexes strings, template literals and regex literals
// before deciding what a comment opener is, so the glob stays a string. It
// leaves string CONTENTS intact, which this guard needs — the hostname /
// protocol / path values it reads are string literals. Comments are still
// blanked in place (length and newlines preserved), which is what keeps the
// prose in this repo's config — it discusses `browserName` and `port` at
// length — from being read as configuration in either direction.

/**
 * Raised when the config cannot be read structurally at all: no exported
 * `config` object, or a brace that never closes. Distinct from a broken
 * gate — the guard has not disproved anything, it has failed to LOOK, and
 * that must never render as "ok". A `ScanError` from the shared scanner is
 * surfaced the same way.
 */
export class UnscannableConfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnscannableConfError'
  }
}

// The exported config object's own source, braces included. Everything the
// remote-driver gate reads must come from HERE and not from the file at
// large: `definesRemoteDriver(options)` is handed `config`, so a `port:` or
// `hostname:` in an unrelated helper says nothing about the driver. #3990
// item 2 is exactly that — the old scan matched anywhere in the file, so a
// stray `hostname: '0.0.0.0'` in a nested object kept the gate satisfied with
// every remote-driver option gone from `config`.
const CONFIG_DECL_RE = /(^|\n)\s*export\s+const\s+config\b/

function configObjectSource(strippedSource) {
  const decl = CONFIG_DECL_RE.exec(strippedSource)
  if (decl === null) {
    throw new UnscannableConfError('no `export const config` declaration found')
  }
  const eq = strippedSource.indexOf('=', decl.index + decl[0].length)
  if (eq === -1) throw new UnscannableConfError('`export const config` has no initializer')
  const open = strippedSource.indexOf('{', eq)
  if (open === -1) {
    throw new UnscannableConfError(
      '`export const config` is not initialized with an object literal',
    )
  }
  const close = findMatchingBracket(strippedSource, open)
  if (close === -1) throw new UnscannableConfError('the `config` object literal never closes')
  return strippedSource.slice(open, close + 1)
}

/**
 * Blank (length- and newline-preserving) everything nested more than one
 * level deep inside `objSource`, so only the object's OWN members remain
 * matchable. `definesRemoteDriver(options)` reads `options.port`,
 * `options.hostname`, … — top-level properties. A `hostname` inside
 * `capabilities: [{ … }]`, or inside an `onPrepare: () => { … }` hook body,
 * is not one of them and is not evidence.
 */
function topLevelMembersOnly(objSource) {
  const out = objSource.split('')
  let depth = 0
  let nestedFrom = -1
  for (const tok of tokenize(objSource)) {
    if (tok.kind !== 'punct') continue
    const v = tok.value
    if (v === '(' || v === '[' || v === '{') {
      depth++
      if (depth === 2) nestedFrom = tok.end
    } else if (v === ')' || v === ']' || v === '}') {
      if (depth === 2 && nestedFrom !== -1) {
        for (let k = nestedFrom; k < tok.start; k++) if (out[k] !== '\n') out[k] = ' '
        nestedFrom = -1
      }
      depth--
    }
  }
  return out.join('')
}

/**
 * The view gate 2 reads: the config object's own members, comments blanked.
 *
 * Module-local on purpose. It was exported with no consumer inside or outside
 * this file — the self-test reaches it through `remoteDriverEvidence`, which is
 * the surface that actually decides the gate. An exported helper nothing calls
 * is a public API to keep honest for free.
 */
function remoteDriverScope(source) {
  return topLevelMembersOnly(configObjectSource(stripComments(source)))
}

// An object KEY, quoted or not, not preceded by a `.` (so a property
// READ like `caps.browserName` in a helper is not mistaken for a
// declaration) and not part of a longer identifier. Built fresh per call:
// these are matched with `g` (every occurrence, not just the first — #3990
// item 2), and a shared global regex carries `lastIndex` between calls.
function keyPattern(name, valueTail) {
  return new RegExp(`(^|[^\\w$.])['"]?${name}['"]?\\s*:\\s*${valueTail}`, 'g')
}

// EVERY `port:` member, whatever its value — the value is classified after
// the fact by `portIsTruthy`. Matching only the recognised value forms here
// (what the old `PORT_TAIL` did) cannot be made last-wins correctly: an
// unrecognised trailing `port: somePort` would not match at all, so an
// earlier `port: 4444` would win as "the last match" while JS resolves the
// key to the later one.
const ANY_VALUE = String.raw`([^,\n}]*)`
// A numeric literal whose truthiness this guard can decide statically.
const NUMERIC_LITERAL_RE = /^(?:0[xX][\dA-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?)$/
// Value forms whose runtime value is not knowable from source but which are
// deliberately read as "a port is configured".
const DYNAMIC_PORT_RE = /^(?:process\.env\b|Number\s*\(|parseInt\s*\()/
const STRING_VALUE = String.raw`['"]([^'"]*)['"]`
const BROWSER_NAME_RE = /(^|[^\w$.])['"]?browserName['"]?\s*:/

function hasKey(scope, name, valueTail) {
  return keyPattern(name, valueTail).test(scope)
}

/**
 * The value of the LAST `name: '…'` member in `scope`, or `undefined`.
 *
 * Last, not first: duplicate keys in an object literal resolve to the last
 * one in JS, so that is the value `definesRemoteDriver` sees. The old code
 * used `RegExp.exec`, which reads only the FIRST match, so a `hostname`
 * reset to the default further down was invisible to the gate.
 */
function lastStringValue(scope, name) {
  let value
  for (const m of scope.matchAll(keyPattern(name, STRING_VALUE))) value = m[2]
  return value
}

/**
 * Does the config's `port` member make `Boolean(options.port)` true?
 *
 * Two ways this used to disagree with `definesRemoteDriver`, which is the one
 * thing this predicate exists to mirror:
 *
 *   - ANY-match, not last-wins. `port` was the last key still read with
 *     `hasKey` after hostname/protocol/path moved to `lastStringValue`, so
 *     `port: 4444, … port: 0` reported "port is set" while JS resolves the key
 *     to `0` and `definesRemoteDriver` sees `Boolean(0) === false`.
 *   - A falsy literal counted as evidence. `\d[\d_]*` matched `0`, so even a
 *     LONE `port: 0` — a config with no working port at all — held the gate.
 *
 * Unrecognised values (`port: somePort`) stay NOT evidence: the guard errs
 * toward firing, and a human resolves a false alarm in a minute.
 */
function portIsTruthy(scope) {
  let raw
  for (const m of scope.matchAll(keyPattern('port', ANY_VALUE))) raw = m[2].trim()
  if (raw === undefined) return false
  if (NUMERIC_LITERAL_RE.test(raw)) return Number(raw.replaceAll('_', '')) !== 0
  return DYNAMIC_PORT_RE.test(raw)
}

/**
 * Gate 2 — does the config statically satisfy `definesRemoteDriver`?
 * Returns the list of reasons it does (empty ⇒ the gate is gone).
 */
export function remoteDriverEvidence(source) {
  const scope = remoteDriverScope(source)
  const evidence = []
  if (portIsTruthy(scope)) evidence.push('port is set')
  const hostname = lastStringValue(scope, 'hostname')
  if (hostname !== undefined && hostname !== DEFAULT_HOSTNAME) {
    evidence.push(`hostname is non-default (${hostname})`)
  }
  const protocol = lastStringValue(scope, 'protocol')
  if (protocol !== undefined && protocol !== DEFAULT_PROTOCOL) {
    evidence.push(`protocol is non-default (${protocol})`)
  }
  const wdPath = lastStringValue(scope, 'path')
  if (wdPath !== undefined && wdPath !== DEFAULT_PATH) {
    evidence.push(`path is non-default (${wdPath})`)
  }
  if (hasKey(scope, 'user', STRING_VALUE) && hasKey(scope, 'key', STRING_VALUE)) {
    evidence.push('user + key are set (cloud session)')
  }
  return evidence
}

/**
 * Gate 1 — is there a `browserName` capability anywhere in the config?
 *
 * Scanned over the WHOLE FILE, unlike gate 2, and the asymmetry is
 * deliberate: the two gates fail in opposite directions. A stray
 * `browserName:` outside `config` makes THIS gate fire — a false alarm a
 * human resolves in a minute. A stray `port:` outside `config` would make
 * gate 2 PASS, which is the fail-open #3990 item 2 is about. Each is scoped
 * toward its own safe side. Capabilities are also routinely assembled in a
 * helper and spread into `config`, which scoping would hide.
 */
export function hasBrowserNameCapability(source) {
  return BROWSER_NAME_RE.test(stripComments(source))
}

/**
 * Both gates. Returns `{ id, why }` for each gate that no longer holds.
 */
export function checkWdioConf(source) {
  const broken = []
  if (hasBrowserNameCapability(source)) {
    broken.push({
      id: 'no-browser-session',
      why:
        'a `browserName` capability appeared. `mapCapabilities()` in @wdio/utils/build/node.js ' +
        'keeps exactly the capabilities that HAVE a browserName, and the launcher hands those to ' +
        'setupBrowser()/setupDriver() — which download a browser build and unpack it through ' +
        'extract-zip.',
    })
  }
  let evidence
  try {
    evidence = remoteDriverEvidence(source)
  } catch (err) {
    if (!(err instanceof UnscannableConfError) && !(err instanceof ScanError)) throw err
    // Gate 1 scans the WHOLE file and needs no `export const config`, so it can
    // already have found the breach by the time gate 2 discovers it cannot read
    // the config structurally at all. Dropping that finding on the floor is how
    // `export default { capabilities: [{ browserName: 'chrome' }] }` reported
    // only "no `export const config` declaration found" — true, and silent
    // about the capability that is the actual breach. The unscannable verdict
    // still stands (gate 2 is genuinely undecided, so this stays exit 2); it
    // just carries what gate 1 did manage to establish.
    err.brokenGates = broken
    throw err
  }
  if (evidence.length === 0) {
    broken.push({
      id: 'remote-driver-options',
      why:
        'nothing in the config makes `definesRemoteDriver(options)` true any more (no port, no ' +
        'non-default hostname/protocol/path, no user+key). That predicate is the second half of ' +
        'the same filter, and it also gates startWebDriver() — without it WDIO manages a local ' +
        'driver itself, which is the code path that downloads and unpacks browser archives.',
    })
  }
  return broken
}

// ─── driver ──────────────────────────────────────────────────────────

const ALERT_EXPLANATION = `
Dependabot alert #50 — extract-zip <= 2.0.1, unvalidated symlink path traversal
(CVE-2026-56876, GHSA-x7jf-2287-qcpf, HIGH). THERE IS NO PATCHED VERSION: 2.0.1
is the latest release, so the alert cannot be closed by upgrading.

It was dismissed as unreachable, and the reachability argument is precisely the
property that just broke. The dependency path

    @wdio/cli → @wdio/utils → @puppeteer/browsers → extract-zip

is only inert while WDIO never downloads a browser archive: extract-zip is called
from unpackArchive() in @puppeteer/browsers, reached only via
setupPuppeteerBrowser() in @wdio/utils/build/node.js.

Do NOT delete this guard to get green. Either restore the property, or
re-evaluate alert #50 on its merits — with the config above, wdio downloads a
browser build and unpacks a zip through unvalidated symlink handling, in a
process that has your checkout and your credentials.
`

// Repo-relative when the file is in the repo (the normal case), absolute
// otherwise — a `--conf` pointed at a scratch copy under /tmp otherwise
// renders as a wall of `../../..`.
function displayPath(target) {
  const rel = path.relative(ROOT, target)
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : target
}

function run(confPath) {
  if (!fs.existsSync(confPath)) {
    console.error(`check-wdio-driver-gate: missing ${displayPath(confPath)}`)
    console.error(
      'The wdio config is the only thing pinning the reachability argument for alert #50.',
    )
    return 2
  }
  let broken
  try {
    broken = checkWdioConf(fs.readFileSync(confPath, 'utf8'))
  } catch (err) {
    if (!(err instanceof UnscannableConfError) && !(err instanceof ScanError)) throw err
    // "I could not read it" is not "it is fine". Both gates are decided by
    // reading the config, so a config this guard cannot read structurally
    // leaves alert #50's reachability argument unverified — which must exit
    // non-zero, not print ok.
    console.error(`check-wdio-driver-gate: cannot verify ${displayPath(confPath)} — ${err.message}`)
    // Anything gate 1 established before gate 2 gave up is still a breach and
    // still the most useful thing on screen — naming only the unreadability
    // buries the capability that is the actual problem.
    const found = err.brokenGates ?? []
    if (found.length > 0) {
      console.error('\nWhat this guard DID establish before it lost the thread:\n')
      for (const gate of found) console.error(`  [${gate.id}] ${gate.why}\n`)
    }
    console.error(
      '\nThe two gates are decided by reading `export const config`. Without it this guard has\n' +
        'not disproved anything, so it reports failure rather than success. Restore a readable\n' +
        '`export const config = { … }`, or re-evaluate Dependabot alert #50 on its merits.',
    )
    return 2
  }
  if (broken.length === 0) {
    console.log('check-wdio-driver-gate: ok (no browserName capability; remote driver configured)')
    return 0
  }
  console.error(
    `check-wdio-driver-gate: ${displayPath(confPath)} no longer keeps ` +
      `WDIO out of the browser-download path\n`,
  )
  for (const gate of broken) console.error(`  [${gate.id}] ${gate.why}\n`)
  console.error(ALERT_EXPLANATION)
  return 1
}

// ─── self-test ───────────────────────────────────────────────────────
//
// Proves the guard is CAPABLE of failing, on both gates independently,
// and that it does not fire on shapes that are still safe.

function selfTest() {
  const failures = []
  const check = (name, condition) => {
    if (!condition) failures.push(name)
  }

  const real = fs.readFileSync(path.join(ROOT, WDIO_CONF), 'utf8')

  // Fixtures are built by editing the REAL config, so a fixture that no
  // longer applies would silently degrade into "the real file, again" and the
  // assertion built on it would pass without testing anything. `sub` reports
  // that as a self-test FAILURE instead — the staleness, not a restatement of
  // the substitution.
  const sub = (source, from, to) => {
    if (!source.includes(from)) {
      failures.push(`self-test fixture is stale: ${WDIO_CONF} no longer contains ${from}`)
      return source
    }
    return source.replace(from, to)
  }

  check('the checked-in wdio.conf.ts passes both gates', checkWdioConf(real).length === 0)
  check(
    'the checked-in config satisfies definesRemoteDriver via its port',
    remoteDriverEvidence(real).includes('port is set'),
  )

  // Gate 2 — remove the port. The real file also sets a non-default
  // hostname, so BOTH have to go for definesRemoteDriver to become false;
  // dropping only the port leaves the gate satisfied, and the guard must
  // say so rather than firing on a config that is still safe.
  const noPort = real.replace(/\n\s*port:\s*4444,/, '')
  check(
    'removing only the port leaves the gate satisfied (the non-default hostname still holds it)',
    checkWdioConf(noPort).length === 0,
  )
  const noRemote = noPort.replace(/\n\s*hostname:\s*'[^']*',/, '')
  check(
    'removing every remote-driver option FAILS the gate',
    checkWdioConf(noRemote).some((g) => g.id === 'remote-driver-options'),
  )
  check(
    'a hostname set to the DEFAULT does not satisfy the gate',
    remoteDriverEvidence(noRemote.replace('runner:', `hostname: '${DEFAULT_HOSTNAME}',\n  runner:`))
      .length === 0,
  )
  check(
    'a non-default hostname alone DOES satisfy the gate (mirrors definesRemoteDriver)',
    remoteDriverEvidence(noRemote.replace('runner:', "hostname: '10.0.0.9',\n  runner:")).length ===
      1,
  )
  check(
    'a COMMENTED-OUT port does not satisfy the gate',
    // Inside the config object, so this tests comment stripping and not the
    // scoping added below — appended after the object it would be excluded
    // for the other reason and the assertion would stop testing its subject.
    remoteDriverEvidence(sub(noRemote, 'runner:', '// port: 4444\n  runner:')).length === 0,
  )

  // ── #3990 item 2 — scope. `definesRemoteDriver(options)` is handed
  // `config`, and reads its TOP-LEVEL options. The old scan matched anywhere
  // in the file, so evidence could come from code WDIO never looks at.
  check(
    'a hostname in an unrelated object OUTSIDE `config` is not evidence',
    remoteDriverEvidence(`const cluster = { hostname: '0.0.0.0' }\n${noRemote}`).length === 0,
  )
  check(
    'a hostname NESTED inside `config` (not a top-level option) is not evidence',
    remoteDriverEvidence(
      sub(noRemote, "'tauri:options': {", "hostname: '0.0.0.0',\n      'tauri:options': {"),
    ).length === 0,
  )

  // ── #3990 item 2, second half — `exec` read only the FIRST match, so a
  // value restored to the default later on was invisible. Duplicate keys
  // resolve to the LAST one in JS; both directions are pinned, since pinning
  // only "a later non-default is seen" also passes for a scan that reads
  // every match and takes the most alarming.
  const twoHostnames = (first, second) =>
    remoteDriverEvidence(
      sub(noRemote, 'runner:', `hostname: '${first}',\n  hostname: '${second}',\n  runner:`),
    )
  check(
    'a non-default hostname LATER in the config is seen, not just the first match',
    twoHostnames(DEFAULT_HOSTNAME, '10.0.0.9').length === 1,
  )
  check(
    'a hostname reset to the DEFAULT later in the config wins over the earlier non-default',
    twoHostnames('10.0.0.9', DEFAULT_HOSTNAME).length === 0,
  )

  // ── `port` has to agree with `Boolean(options.port)` the same way the
  // string keys agree with theirs. It was the last key still read with an
  // ANY-match after hostname/protocol/path became last-wins, and its value
  // pattern (`\d[\d_]*`) accepted a falsy `0`. Both halves are pinned, in
  // both directions — a fix that simply vetoed any `0` anywhere would pass
  // the two failing cases while breaking a config that is genuinely fine.
  const withPorts = (...ports) =>
    remoteDriverEvidence(
      sub(noRemote, 'runner:', `${ports.map((p) => `port: ${p},`).join('\n  ')}\n  runner:`),
    )
  check(
    'a LONE `port: 0` does not satisfy the gate (definesRemoteDriver sees Boolean(0) === false)',
    withPorts(0).length === 0,
  )
  check(
    'a port RESET to 0 later in the config wins over the earlier real one',
    withPorts(4444, 0).length === 0,
  )
  check(
    'a real port LATER in the config is still seen (the zero check is not a blanket veto)',
    withPorts(0, 4444).length === 1,
  )
  check('a lone real port satisfies the gate', withPorts(4444).length === 1)
  check(
    'an UNRECOGNISED port value later in the config is not evidence (errs toward firing)',
    withPorts(4444, 'somePort').length === 0,
  )

  // Gate 1 — a browserName capability appears.
  const withBrowser = real.replace(
    "'tauri:options': {",
    "browserName: 'chrome',\n      'tauri:options': {",
  )
  check(
    'adding a browserName capability FAILS the gate',
    checkWdioConf(withBrowser).some((g) => g.id === 'no-browser-session'),
  )
  check(
    'a QUOTED browserName key is caught too',
    hasBrowserNameCapability(`capabilities: [{ 'browserName': 'firefox' }]`),
  )
  check(
    'browserName mentioned only in a comment does NOT trip the gate',
    !hasBrowserNameCapability('// we deliberately set no browserName: capability here\n'),
  )
  check(
    'browserName inside a block comment does NOT trip the gate',
    !hasBrowserNameCapability('/*\n * no browserName: capability, on purpose\n */\n'),
  )
  check(
    'a property READ (caps.browserName) is not mistaken for a capability',
    !hasBrowserNameCapability('const x = caps.browserName ? 1 : 2\n'),
  )

  // Both gates gone at once — the shape that actually makes the download
  // reachable (`browserName` present AND no remote driver, which is the
  // stock "let WDIO drive a local Chrome" config). Must report BOTH, so a
  // reader who fixes one does not think they are done.
  {
    const vulnerable = "export const config = { capabilities: [{ browserName: 'chrome' }] }"
    const broken = checkWdioConf(vulnerable)
    check(
      'the stock local-Chrome shape fails BOTH gates and names both',
      broken.length === 2 &&
        broken.some((g) => g.id === 'no-browser-session') &&
        broken.some((g) => g.id === 'remote-driver-options'),
    )
  }
  // ── #3990 item 1 — the fail-open this guard shipped with. The old
  // `stripTsComments` had no string awareness, so a glob that OPENS a block
  // comment without closing it, plus any block-comment terminator further
  // down, blanked every line between them — including the `browserName`
  // capability. The guard printed "ok" for a config that downloads a browser.
  //
  // All three edits are made to the REAL config, in their real positions:
  // widen the existing `specs` glob, add a browserName to the existing
  // capability, and put an ordinary JSDoc block below `capabilities`.
  {
    const fooled = sub(
      sub(
        sub(real, "specs: ['./e2e-tauri/**/*.e2e.ts'],", "specs: ['./e2e-tauri/**'],"),
        "'tauri:options': {",
        "browserName: 'chrome',\n      'tauri:options': {",
      ),
      '  // Real WebKitWebView boot',
      '  /**\n   * Ordinary JSDoc, anywhere below the capabilities block.\n   */\n' +
        '  // Real WebKitWebView boot',
    )
    check(
      'a glob that opens a block comment cannot blank the browserName line out of the config',
      checkWdioConf(fooled).some((g) => g.id === 'no-browser-session'),
    )
  }
  check(
    'a block-comment opener inside a STRING does not blank the code after it',
    hasBrowserNameCapability(
      "export const config = { specs: ['./e2e/**'], capabilities: [{ browserName: 'chrome' }] }\n" +
        '/** and a JSDoc block below it */\n',
    ),
  )

  // A config this guard cannot read structurally is NOT ok. Both gates are
  // decided by reading `export const config`; without it the guard has
  // disproved nothing. The old code answered "the remote-driver gate is
  // broken" for an empty file, which reads as a verdict about the config
  // rather than about the guard's ability to see it.
  {
    let threw = null
    try {
      checkWdioConf('')
    } catch (err) {
      threw = err
    }
    check(
      'a source with no `export const config` is reported UNSCANNABLE, not as a broken gate',
      threw instanceof UnscannableConfError,
    )
  }
  {
    // …and an unscannable config must not swallow what gate 1 ALREADY found.
    // A config refactored to a default export is unreadable for gate 2, but
    // the `browserName` capability is right there in the source. Reporting
    // only "no `export const config` declaration found" is true and useless:
    // it names the guard's problem and hides the config's.
    const defaultExport = "export default { capabilities: [{ browserName: 'chrome' }] }"
    let threw = null
    try {
      checkWdioConf(defaultExport)
    } catch (err) {
      threw = err
    }
    check(
      'an unscannable config still carries the browserName breach gate 1 already found',
      threw instanceof UnscannableConfError &&
        (threw.brokenGates ?? []).some((g) => g.id === 'no-browser-session'),
    )

    // …and it reaches the printed REPORT, not just the thrown object, while
    // the exit code stays 2 — gate 2 is genuinely undecided, so this is a
    // message-quality fix and must not quietly become an exit-1 verdict.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdio-gate-selftest-'))
    const tmp = path.join(tmpDir, 'wdio.conf.ts')
    fs.writeFileSync(tmp, `${defaultExport}\n`)
    const realConsoleError = console.error
    const printed = []
    console.error = (...args) => printed.push(args.join(' '))
    let code
    try {
      code = run(tmp)
    } finally {
      console.error = realConsoleError
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    const report = printed.join('\n')
    check(
      'the unscannable-config report NAMES the browserName capability, still exiting 2',
      code === 2 && report.includes('browserName') && report.includes('no-browser-session'),
    )
  }
  {
    // …and that reaches the EXIT CODE. A `port: 4444` sitting outside the
    // config is exactly the evidence the old file-wide scan would have
    // accepted, so this fixture also pins that it no longer does.
    // mkdtemp, not a pid-derived name: `wdio-gate-selftest-<pid>.ts` in the
    // shared temp dir is predictable, so anyone on the box can pre-place a
    // symlink there and have this write follow it. mkdtemp gets a 0700 dir
    // with an unguessable suffix (CodeQL js/insecure-temporary-file).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdio-gate-selftest-'))
    const tmp = path.join(tmpDir, 'wdio.conf.ts')
    fs.writeFileSync(tmp, "const notTheConfig = { port: 4444, hostname: '10.0.0.9' }\n")
    const realConsoleError = console.error
    console.error = () => {}
    let code
    try {
      code = run(tmp)
    } finally {
      console.error = realConsoleError
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    check('an unscannable config exits non-zero rather than printing ok', code === 2)
  }

  if (failures.length > 0) {
    console.error('check-wdio-driver-gate --self-test FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    return 2
  }
  console.log('check-wdio-driver-gate --self-test: ok')
  return 0
}

const confArgIndex = process.argv.indexOf('--conf')
const confPath =
  confArgIndex !== -1 && process.argv[confArgIndex + 1]
    ? path.resolve(process.argv[confArgIndex + 1])
    : path.join(ROOT, WDIO_CONF)

process.exit(process.argv.includes('--self-test') ? selfTest() : run(confPath))
