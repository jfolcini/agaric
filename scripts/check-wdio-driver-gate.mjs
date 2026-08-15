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
import path from 'node:path'

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

/**
 * Blank out `//` line comments and block comments, preserving line count
 * and total length so offsets stay meaningful. String literals are NOT
 * parsed: the header prose in `wdio.conf.ts` legitimately discusses
 * `browserName` and `port`, and a comment that mentions a key must not
 * be mistaken for the key itself — in either direction. A commented-out
 * `port: 4444` must NOT satisfy the remote-driver gate, and a comment
 * explaining why there is no `browserName` must NOT trip the browser
 * gate.
 */
export function stripTsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

// An object KEY, quoted or not, not preceded by a `.` (so a property
// READ like `caps.browserName` in a helper is not mistaken for a
// declaration) and not part of a longer identifier.
function keyPattern(name, valueTail) {
  return new RegExp(`(^|[^\\w$.])['"]?${name}['"]?\\s*:\\s*${valueTail}`)
}

// Value forms that mean "a port is configured": a numeric literal, or the
// usual env/parse wrappers. A `port` set to something unrecognised is
// deliberately NOT counted — this guard errs toward firing.
const PORT_RE = keyPattern('port', String.raw`(\d[\d_]*|process\.env|Number\s*\(|parseInt\s*\()`)
const STRING_VALUE = String.raw`['"]([^'"]*)['"]`
const HOSTNAME_RE = keyPattern('hostname', STRING_VALUE)
const PROTOCOL_RE = keyPattern('protocol', STRING_VALUE)
const PATH_RE = keyPattern('path', STRING_VALUE)
const USER_RE = keyPattern('user', STRING_VALUE)
const KEY_RE = keyPattern('key', STRING_VALUE)
const BROWSER_NAME_RE = /(^|[^\w$.])['"]?browserName['"]?\s*:/

/**
 * Gate 2 — does the config statically satisfy `definesRemoteDriver`?
 * Returns the list of reasons it does (empty ⇒ the gate is gone).
 */
export function remoteDriverEvidence(source) {
  const src = stripTsComments(source)
  const evidence = []
  if (PORT_RE.test(src)) evidence.push('port is set')
  const hostname = HOSTNAME_RE.exec(src)?.[2]
  if (hostname !== undefined && hostname !== DEFAULT_HOSTNAME) {
    evidence.push(`hostname is non-default (${hostname})`)
  }
  const protocol = PROTOCOL_RE.exec(src)?.[2]
  if (protocol !== undefined && protocol !== DEFAULT_PROTOCOL) {
    evidence.push(`protocol is non-default (${protocol})`)
  }
  const wdPath = PATH_RE.exec(src)?.[2]
  if (wdPath !== undefined && wdPath !== DEFAULT_PATH) {
    evidence.push(`path is non-default (${wdPath})`)
  }
  if (USER_RE.test(src) && KEY_RE.test(src)) evidence.push('user + key are set (cloud session)')
  return evidence
}

/** Gate 1 — is there a `browserName` capability anywhere in the config? */
export function hasBrowserNameCapability(source) {
  return BROWSER_NAME_RE.test(stripTsComments(source))
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
  if (remoteDriverEvidence(source).length === 0) {
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
  const broken = checkWdioConf(fs.readFileSync(confPath, 'utf8'))
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
    remoteDriverEvidence(`${noRemote}\n// port: 4444\n`).length === 0,
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
  // An empty config breaks only the remote-driver gate: with no
  // capabilities there is no browserName either. Pinned so a future
  // "fail everything on an empty file" shortcut does not quietly make the
  // two gates indistinguishable.
  {
    const broken = checkWdioConf('')
    check(
      'an empty config fails ONLY the remote-driver gate',
      broken.length === 1 && broken[0]?.id === 'remote-driver-options',
    )
  }

  // stripTsComments must preserve line count; a guard whose stripper eats
  // newlines reports the wrong place when it grows a line number.
  check(
    'comment stripping preserves line count',
    stripTsComments('a\n/* x\n y */\nb\n// c\nd\n').split('\n').length ===
      'a\n/* x\n y */\nb\n// c\nd\n'.split('\n').length,
  )

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
