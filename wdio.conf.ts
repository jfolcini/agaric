// ---------------------------------------------------------------------------
// WebdriverIO + tauri-driver configuration (issue #155).
//
// This drives the REAL Agaric desktop binary in a real WebKitWebView via
// `tauri-driver`, exercising the genuine Rust backend over real Tauri IPC — it
// does NOT use the JS mock. `src/main.tsx` only installs the mock when
// `window.__TAURI_INTERNALS__` is absent; a real Tauri binary provides it, so
// the app talks to the live backend automatically. The binary is therefore a
// plain (non-`VITE_E2E`) debug build.
//
// Setup mirrors the canonical Tauri v2 WebDriver guide:
//   https://v2.tauri.app/develop/tests/webdriver/example/webdriverio/
//   https://v2.tauri.app/develop/tests/webdriver/
//
// `tauri-driver` is a CARGO binary (`cargo install tauri-driver --locked`),
// NOT an npm package. On Linux it proxies `WebKitWebDriver` (shipped by the
// `webkit2gtk-driver` apt package) on an internal port and exposes the
// WebDriver endpoint WDIO connects to at 127.0.0.1:4444. Both are installed by
// the weekly workflow (`.github/workflows/e2e-tauri-weekly.yml`); this box
// cannot run them, so the harness is validated on the first scheduled/dispatch
// run.
// ---------------------------------------------------------------------------

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Directory of this config file (the repo root). Node >= 24 (see package.json
// `engines`) provides `import.meta.dirname` natively.
const rootDir = import.meta.dirname

// Path to the built debug binary. The Cargo package is named `agaric`
// (`default-run = "agaric"` in src-tauri/Cargo.toml), so `tauri build` emits
// the executable at src-tauri/target/debug/agaric. `tauri.conf.json` sets no
// `mainBinaryName`, so the Cargo bin name — not the "Agaric" productName —
// governs the on-disk filename. Overridable for local experimentation.
const application =
  process.env['TAURI_APP_BINARY'] ?? path.resolve(rootDir, 'src-tauri', 'target', 'debug', 'agaric')

// `tauri-driver` lands in ~/.cargo/bin from `cargo install`. Allow an override
// so a CI runner with a non-standard CARGO_HOME can point at it directly.
const tauriDriverPath =
  process.env['TAURI_DRIVER_PATH'] ?? path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver')

// `tauri:options` is the Tauri WebDriver vendor-prefixed capability
// tauri-driver reads to launch the app; @wdio/types doesn't ship it, so we
// declaration-merge it onto the capability interface for a typed config.
declare global {
  namespace WebdriverIO {
    interface Capabilities {
      'tauri:options'?: {
        application: string
      }
    }
  }
}

// On-failure diagnostics land here; the weekly workflow uploads this directory
// as a CI artifact (`if: failure()`) so a red run is diagnosable without a
// local WebKit driver.
const ARTIFACTS_DIR = path.resolve(rootDir, 'e2e-tauri', 'artifacts')

// Diagnostics excerpts are capped so a giant real-backend DOM can't flood the
// spec reporter; the screenshot + uploaded artifacts carry the full picture.
const DIAG_EXCERPT_CAP = 3000

/** Make a string safe as a single path segment for a screenshot filename. */
function sanitizeForFilename(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned || 'failure').slice(0, 120)
}

// ---------------------------------------------------------------------------
// "Why was it not displayed?" (#4428).
//
// `waitForDisplayed` fails with one sentence — `element ("<selector>") still
// not displayed after 60000ms` — and that sentence cannot tell the two failures
// it covers apart:
//
//   * the asserted state NEVER EXISTED (the backend lost the write, the view
//     did not re-query) — the failure the spec was written to catch; or
//   * the state exists and something is HIDING it (a stuck fade, a modal, a
//     collapsed container) — a rendering bug in code the spec is not about.
//
// The lane paid for that ambiguity: runs 31355052132 / 32687143146 failed on
// `tag-roundtrip.e2e.ts`, the #3081 regression guard, and read as a tag
// regression for three weeks. The tag was in the DOM the whole time; the
// App-level view-transition wrapper was stuck at `opacity-0` (#3388/#4393), so
// `checkVisibility` — which honours ancestor opacity — returned false for the
// full 60s. The evidence was already in the artifacts (the screenshot shows a
// blank pane under a correct sidebar; the testid dump lists the tag) and was
// still misread, because nothing in the output NAMED the ancestor.
//
// So on a failure we now ask the page directly, and name it.
// ---------------------------------------------------------------------------

/**
 * Recover the selector a failing WDIO wait was watching from its own message.
 *
 * WDIO renders these as `element ("<selector>") still not displayed after Nms`.
 * The selector itself routinely contains `"` (every `[data-testid="…"]`), so
 * the capture is GREEDY and anchored on the ` still not ` tail, which the
 * selector cannot contain. Returns `undefined` for any other failure (a plain
 * `expect`, a `waitUntil` with a custom `timeoutMsg`), which is the signal to
 * skip the probe rather than guess.
 */
export function selectorFromWaitFailure(message: string): string | undefined {
  return /element \("(.+)"\) still not (?:displayed|clickable|existing|enabled)/.exec(message)?.[1]
}

/** Flat by design: a discriminated union buys nothing across the wire. */
export interface VisibilityProbe {
  status: 'absent' | 'present' | 'unsupported-selector'
  width: number
  height: number
  /** Human-readable: every node on the ancestor chain that hides the element. */
  hiddenBy: string[]
}

/**
 * Runs IN THE PAGE. Walks from the element to the document root and reports
 * every node whose computed style takes the element off screen.
 *
 * Ancestors matter as much as the element: `opacity`, `display` and
 * `visibility` are all inherited-in-effect for hit/visibility testing, and it
 * is precisely an ANCESTOR that hid the tag. Reporting only the element's own
 * style would have reproduced the original misdiagnosis.
 *
 * WDIO selectors are not all CSS (`button*=Add Tag`, `.//button[…]`), so an
 * invalid `querySelector` argument is reported as such rather than thrown —
 * this is diagnostics, and diagnostics may never become the failure.
 */
export function probeVisibilityInPage(selector: string): VisibilityProbe {
  let element: Element | null = null
  try {
    element = document.querySelector(selector)
  } catch {
    return { status: 'unsupported-selector', width: 0, height: 0, hiddenBy: [] }
  }
  if (!element) return { status: 'absent', width: 0, height: 0, hiddenBy: [] }

  const describe = (node: Element): string => {
    const testid = node.getAttribute('data-testid')
    const cls = node.getAttribute('class') ?? ''
    const shortCls = cls.length > 100 ? `${cls.slice(0, 100)}…` : cls
    const testidPart = testid === null ? '' : ` data-testid="${testid}"`
    const classPart = shortCls === '' ? '' : ` class="${shortCls}"`
    return `<${node.tagName.toLowerCase()}${testidPart}${classPart}>`
  }

  const hiddenBy: string[] = []
  let node: Element | null = element
  let depth = 0
  while (node) {
    const style = window.getComputedStyle(node)
    const reasons: string[] = []
    if (style.display === 'none') reasons.push('display:none')
    if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      reasons.push(`visibility:${style.visibility}`)
    }
    // `parseFloat`, not `Number`: a computed style that reports opacity as ''
    // (an engine that has not resolved it) coerces to 0 under `Number` and
    // would make EVERY node "hidden by opacity:0", which is the loudest
    // possible way for a diagnostic to be wrong. Unresolved is not zero.
    const opacity = Number.parseFloat(style.opacity)
    if (Number.isFinite(opacity) && opacity === 0) reasons.push('opacity:0')
    if (style.contentVisibility === 'hidden') reasons.push('content-visibility:hidden')
    if (reasons.length > 0) {
      const where = depth === 0 ? 'the element itself' : `ancestor ${depth} level(s) up`
      hiddenBy.push(`${where} ${describe(node)} — ${reasons.join(', ')}`)
    }
    node = node.parentElement
    depth += 1
  }

  const rect = element.getBoundingClientRect()
  return {
    status: 'present',
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    hiddenBy,
  }
}

/**
 * Turn a probe into the one sentence a reader of a red run needs, which is
 * always an answer to "is the asserted state missing, or merely invisible?".
 */
export function explainVisibilityProbe(selector: string, probe: VisibilityProbe): string {
  const head = `[afterTest] why "${selector}" never became displayed:`
  if (probe.status === 'unsupported-selector') {
    return `${head} not a CSS selector, so the DOM probe could not resolve it (no verdict).`
  }
  if (probe.status === 'absent') {
    return (
      `${head} NO element matches it. The asserted state is genuinely MISSING — ` +
      'this is the failure the spec exists to catch, not a rendering artefact.'
    )
  }
  if (probe.hiddenBy.length > 0) {
    return (
      `${head} the element IS in the DOM (${probe.width}x${probe.height}px) but is hidden by ` +
      `${probe.hiddenBy.join('; ')}. The asserted state EXISTS — this is a RENDERING failure ` +
      'in whatever owns that node, NOT a failure of the feature under test.'
    )
  }
  if (probe.width === 0 || probe.height === 0) {
    return (
      `${head} the element is in the DOM and nothing hides it, but its box is ` +
      `${probe.width}x${probe.height}px — it is laid out to zero size.`
    )
  }
  return (
    `${head} the element is in the DOM, unhidden, and ${probe.width}x${probe.height}px RIGHT NOW — ` +
    'it became visible after the wait expired. A timing failure, not a state failure.'
  )
}

// ---------------------------------------------------------------------------
// Vault isolation (#3334).
//
// These specs create journal blocks, pages and tags through the REAL backend
// and never clean up. Until this existed the app resolved its storage from the
// `com.agaric.app` bundle identifier alone — `~/.local/share/com.agaric.app` on
// Linux — so every local run wrote into the DEVELOPER'S OWN NOTES, and a second
// run the same day could go green against the first run's leftover block
// instead of against anything the backend had just persisted.
//
// The isolation is two independent layers, both anchored to one throwaway
// directory per run:
//
//   1. `AGARIC_DATA_DIR` — the app's own override (src-tauri/src/app_paths.rs),
//      honoured on every platform, which is what actually relocates the vault.
//   2. `XDG_*_HOME` — relocates the OS-default itself on Linux, so even a
//      binary too old to know about layer 1 cannot reach the real vault.
//
// `AGARIC_E2E_SANDBOX` is the part that makes this a guarantee rather than a
// convention: with it set, the app REFUSES TO BOOT if `AGARIC_DATA_DIR` is
// missing, empty, relative, or aimed at the OS-default directory. There is no
// silent fallback to the real vault, which is the failure mode that made this
// worth fixing — an isolation mechanism that quietly degrades to "use the real
// vault" is worse than none, because it invites trust it cannot honour.
//
// The `before` hook below then PROVES, at runtime, that the running binary
// actually obeyed, and aborts the run before a single spec asserts anything if
// it did not.
// ---------------------------------------------------------------------------

// Filename prefix of every per-session sandbox, created directly under the OS
// temp dir. There is deliberately NO fixed parent directory:
//
//   - A shared parent would have to be swept, and any sweep of it deletes a
//     CONCURRENTLY RUNNING invocation's live vault out from under its open
//     SQLite handle. `mkdtempSync` exists precisely to isolate concurrent runs;
//     a `rm -rf` of their common parent gives that isolation straight back.
//   - A fixed name under a world-writable `$TMPDIR` is predictable, so another
//     local user can pre-create it and thereby choose where this suite's data
//     lands. `mkdtempSync` picks the random suffix itself and creates the
//     directory with mode 0700, which is neither pre-creatable nor readable by
//     anyone else.
const SANDBOX_PREFIX = 'agaric-wdio-vault-'

// Litter from a run that was killed before `afterSession` could clean up is
// swept by age, never wholesale: a live sandbox is minutes old, so a day-old
// floor cannot reach one. This is the only reason the prefix needs to be
// recognisable at all.
const SANDBOX_STALE_AFTER_MS = 24 * 60 * 60 * 1000

// Set once per session in `beforeSession`, read by `before` and `afterSession`.
// All three run in the SAME worker process, so this needs no cross-process
// channel — and the process that sets it is the one that spawns `tauri-driver`,
// which is the only process whose environment can reach the app.
let sandboxRunDir: string | undefined
let sandboxVaultDir: string | undefined

/**
 * Delete sandboxes left behind by runs that were killed, without touching one
 * that is still in use. Age is the discriminator: anything older than
 * `SANDBOX_STALE_AFTER_MS` cannot be a live session, since the whole suite is
 * bounded by `mochaOpts.timeout`. Best-effort throughout — a temp directory we
 * cannot stat or remove (another user's, or one racing its own owner's
 * cleanup) is skipped, never fatal.
 */
function sweepStaleSandboxes(): void {
  const tmp = os.tmpdir()
  let entries: string[]
  try {
    entries = readdirSync(tmp)
  } catch {
    return
  }
  const staleBefore = Date.now() - SANDBOX_STALE_AFTER_MS
  for (const entry of entries) {
    if (!entry.startsWith(SANDBOX_PREFIX)) continue
    const full = path.join(tmp, entry)
    try {
      if (statSync(full).mtimeMs >= staleBefore) continue
      rmSync(full, { recursive: true, force: true })
    } catch {
      // Not ours, or vanished under us. Either way: not our business.
    }
  }
}

/**
 * Create this session's throwaway directory tree and return the environment the
 * app must be launched with.
 *
 * The vault directory itself is deliberately NOT created here: the app's boot
 * `create_dir_all` is what materialises it, so its existence — and the
 * `notes.db` inside it — is unforgeable evidence that the override was honoured
 * rather than something this config could have faked.
 */
function createSandboxEnv(): NodeJS.ProcessEnv {
  const runDir = mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX))
  sandboxRunDir = runDir
  sandboxVaultDir = path.join(runDir, 'vault')

  const xdg = (name: string): string => {
    const dir = path.join(runDir, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  return {
    ...process.env,
    AGARIC_DATA_DIR: sandboxVaultDir,
    AGARIC_E2E_SANDBOX: '1',
    // Layer 2. `HOME` itself is left alone on purpose: `tauri-driver` and
    // WebKitWebDriver are resolved out of the real home (`~/.cargo/bin`) and
    // load user-level GTK/webkit state from it, so rewriting it would break the
    // harness rather than isolate it. The XDG variables move exactly what the
    // Tauri path resolver reads, and nothing else.
    XDG_DATA_HOME: xdg('xdg-data'),
    XDG_CONFIG_HOME: xdg('xdg-config'),
    XDG_STATE_HOME: xdg('xdg-state'),
    XDG_CACHE_HOME: xdg('xdg-cache'),
  }
}

/**
 * Copy the APP's own log out of the sandbox before teardown destroys it
 * (#4428).
 *
 * The Rust side writes to `<AGARIC_DATA_DIR>/logs/agaric.log*`
 * (`log_dir_for_app_data`, src-tauri/src/lib.rs), and `AGARIC_DATA_DIR` is the
 * per-session `mkdtemp` sandbox — which `afterSession` deletes unconditionally,
 * including after a failure. So the one artefact that carries the BACKEND's
 * account of a red run was being removed exactly when it was needed, and the
 * workflow's "Upload WebdriverIO logs" step, globbing `**\/*.log` from the repo
 * root, shipped three unrelated `node_modules/spdx-*` files instead — 1114
 * bytes of noise, byte-identical across all three failing runs, which is how a
 * step can look like evidence for weeks while collecting none.
 *
 * Copied into `ARTIFACTS_DIR`, which the weekly workflow already uploads.
 * Best-effort: a diagnostics failure must never mask the real test failure.
 */
function rescueAppLogs(label: string): string {
  const vault = sandboxVaultDir
  if (!vault) return 'no sandbox vault was recorded — nothing to rescue.'
  const logDir = path.join(vault, 'logs')
  if (!existsSync(logDir)) {
    return `the app never created ${logDir} — it produced NO log at all this session.`
  }
  const names = readdirSync(logDir).filter((name) => name.startsWith('agaric.log'))
  if (names.length === 0) return `${logDir} exists but holds no agaric.log* file.`
  const destination = path.join(ARTIFACTS_DIR, 'app-logs', label)
  mkdirSync(destination, { recursive: true })
  for (const name of names) {
    copyFileSync(path.join(logDir, name), path.join(destination, name))
  }
  return `rescued ${String(names.length)} app log file(s) into ${destination}`
}

/** Remove this run's sandbox. `WDIO_KEEP_VAULT=1` keeps it for post-mortems. */
function removeSandbox(): void {
  if (process.env['WDIO_KEEP_VAULT']) {
    if (sandboxRunDir) console.warn(`[sandbox] kept for inspection: ${sandboxRunDir}`)
    return
  }
  if (sandboxRunDir) rmSync(sandboxRunDir, { recursive: true, force: true })
  sandboxRunDir = undefined
  sandboxVaultDir = undefined
}

let tauriDriver: ChildProcess | undefined
let shuttingDown = false

function killTauriDriver(): void {
  shuttingDown = true
  tauriDriver?.kill()
  tauriDriver = undefined
}

// Ensure the driver is reaped even if WDIO tears down abnormally (the docs'
// `onShutdown` safety net) so a crashed run never leaves an orphan holding the
// port for the next weekly execution.
function installShutdownGuard(): void {
  const cleanup = () => {
    try {
      killTauriDriver()
      removeSandbox()
    } finally {
      // no-op: signal handlers must not throw
    }
  }
  for (const signal of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, cleanup)
  }
}

export const config: WebdriverIO.Config = {
  runner: 'local',

  // WDIO connects to the endpoint `tauri-driver` exposes.
  //
  // SECURITY (#3972, Dependabot alert #50): these two lines, plus the
  // absence of a browserName capability below, are what keep WDIO out of
  // its browser-download path — `setupBrowser`/`setupDriver` keep only
  // capabilities that have a browserName AND only when
  // `definesRemoteDriver(options)` is false, and that path unpacks a zip
  // through extract-zip <= 2.0.1, for which no patch exists. Removing
  // either property is a real security decision, not a config tidy-up.
  // `scripts/check-wdio-driver-gate.mjs` fails the commit if you do.
  hostname: '127.0.0.1',
  port: 4444,

  specs: ['./e2e-tauri/**/*.e2e.ts'],
  maxInstances: 1,

  capabilities: [
    {
      // Deliberately NO browserName here — see the security note on
      // `hostname`/`port` above (#3972 / alert #50). tauri-driver launches
      // the app itself; WDIO must never be asked to fetch a browser.
      //
      // `tauri:options.application` is the contract `tauri-driver` reads to
      // launch the app under WebKitWebDriver (per the Tauri WebDriver guide).
      'tauri:options': {
        application,
      },
    },
  ],

  // Real WebKitWebView boot + first real-backend IPC round-trip is slower than
  // a headless-chrome mock, so keep the log quiet and the waits generous.
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 300_000,
  },

  // -------------------------------------------------------------------------
  // tauri-driver lifecycle.
  //
  // The guide builds the app in `onPrepare`; the weekly workflow already builds
  // the debug binary in a dedicated step (and sets WDIO_SKIP_TAURI_BUILD=1), so
  // we only build here when that flag is absent — convenient for a local run,
  // a no-op double build in CI. `beforeSession`/`afterSession` spawn and reap
  // `tauri-driver` around each session, exactly as the current docs show.
  // -------------------------------------------------------------------------
  onPrepare: () => {
    installShutdownGuard()
    // Litter control only, and age-filtered so it cannot reach a sandbox a
    // concurrent invocation is still using. Never the isolation itself.
    sweepStaleSandboxes()
    if (process.env['WDIO_SKIP_TAURI_BUILD']) return
    const result = spawnSync('npm', ['run', 'tauri', '--', 'build', '--debug', '--no-bundle'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true,
    })
    if (result.status !== 0) {
      throw new Error(`tauri debug build failed with exit code ${String(result.status)}`)
    }
  },

  beforeSession: () => {
    // #3334 — the app inherits its environment from `tauri-driver` (which
    // hands the binary to WebKitWebDriver, which spawns it), so this spawn is
    // the ONE place the sandbox can be injected. Passed explicitly as `env`
    // rather than mutated into `process.env` and inherited implicitly: an
    // explicit object is what the static guard can check, and what a future
    // refactor cannot silently drop.
    // `onPrepare` runs in the LAUNCHER process; the driver and the sandbox both
    // live here, in the worker. Installing the net here too is what actually
    // reaps them when the worker dies abnormally — otherwise a crashed run
    // leaks a tauri-driver holding port 4444 and a stale vault directory.
    installShutdownGuard()
    const sandboxEnv = createSandboxEnv()
    tauriDriver = spawn(tauriDriverPath, [], {
      stdio: [null, process.stdout, process.stderr],
      env: sandboxEnv,
    })
    tauriDriver.on('error', (error: Error) => {
      console.error('tauri-driver failed to start:', error.message)
      process.exit(1)
    })
    tauriDriver.on('exit', (code: number | null) => {
      if (!shuttingDown) {
        console.error('tauri-driver exited unexpectedly with code:', code)
        process.exit(1)
      }
    })
  },

  // -------------------------------------------------------------------------
  // #3334 — prove the isolation held, before any spec asserts anything.
  //
  // Everything above is an INSTRUCTION to the app. This is the VERIFICATION,
  // and it is the reason the mechanism cannot degrade quietly: a binary that
  // ignored `AGARIC_DATA_DIR` (an old build, a spawn that lost its environment,
  // a refactor that reintroduced a direct `app.path().app_data_dir()`) opens
  // some other vault, so `notes.db` never appears in ours and this throws.
  //
  // Note what is asserted: the RESOLVED PATH, via a file the app creates during
  // boot. Nothing here writes to, reads from, or even names the real vault —
  // the check cannot itself become the thing that touches the developer's data.
  // -------------------------------------------------------------------------
  before: async () => {
    const vault = sandboxVaultDir
    if (!vault) {
      throw new Error(
        '[sandbox] no per-run vault was created — beforeSession did not run. Refusing to ' +
          'start specs: without the sandbox the suite writes into the real vault (#3334).',
      )
    }
    const dbFile = path.join(vault, 'notes.db')
    await browser.waitUntil(() => existsSync(dbFile), {
      timeout: 120_000,
      interval: 500,
      timeoutMsg:
        `[sandbox] the app never created ${dbFile}. It did NOT honour AGARIC_DATA_DIR, so it ` +
        'is running against some other vault — possibly the real one. Aborting the run rather ' +
        'than asserting against unknown storage (#3334). Check that the binary under test is ' +
        'built from a tree containing src-tauri/src/app_paths.rs.',
    })
    console.warn(`[sandbox] verified: the app is using the throwaway vault ${vault}`)
  },

  afterSession: () => {
    killTauriDriver()
    removeSandbox()
  },

  // No sandbox cleanup here on purpose. Each session's directory is removed by
  // its own `afterSession` (and by the worker's shutdown guard if it dies), so
  // the launcher has nothing left to delete — and anything it COULD delete from
  // here would belong to a different, possibly still-running, invocation.

  // -------------------------------------------------------------------------
  // On-failure diagnostics (issue #155 harness hardening).
  //
  // The weekly lane runs once, headless, on CI with no local WebKit driver to
  // reproduce a failure — so a red run must carry its own evidence. On any
  // failing test this captures: (a) a screenshot, (b) a DISTILLED page-source
  // excerpt (the set of `data-testid`s present + text fragments around every
  // "wdio" marker — NOT the full HTML), and (c) the current URL and the
  // sidebar's innerHTML. Each capture is independently try/caught: a
  // diagnostics failure must never mask the real test failure or abort teardown.
  // -------------------------------------------------------------------------
  afterTest: async (test, _context, result) => {
    if (result.passed) return

    const label = sanitizeForFilename(`${test.parent ?? 'suite'}-${test.title ?? 'test'}`)

    // (a) Screenshot.
    try {
      mkdirSync(ARTIFACTS_DIR, { recursive: true })
      const file = path.join(ARTIFACTS_DIR, `${label}.png`)
      await browser.saveScreenshot(file)
      console.warn(`[afterTest] saved screenshot: ${file}`)
    } catch (error) {
      console.warn(`[afterTest] screenshot capture failed: ${String(error)}`)
    }

    // (a2) The verdict that distinguishes "missing" from "merely invisible"
    // (#4428). Runs before the slower captures below so it reflects the DOM as
    // close to the failure as teardown allows.
    try {
      const message = String(
        (result.error as { message?: unknown } | undefined)?.message ?? result.error ?? '',
      )
      const selector = selectorFromWaitFailure(message)
      if (selector === undefined) {
        console.warn('[afterTest] failure is not an element wait — no visibility probe.')
      } else {
        const probe = await browser.execute(probeVisibilityInPage, selector)
        console.warn(explainVisibilityProbe(selector, probe))
      }
    } catch (error) {
      console.warn(`[afterTest] visibility probe failed: ${String(error)}`)
    }

    // (a3) The backend's own account of the session, before `afterSession`
    // deletes the sandbox that holds it (#4428).
    try {
      console.warn(`[afterTest] app logs: ${rescueAppLogs(label)}`)
    } catch (error) {
      console.warn(`[afterTest] app log rescue failed: ${String(error)}`)
    }

    // (c) Current URL.
    try {
      console.warn(`[afterTest] url=${await browser.getUrl()}`)
    } catch (error) {
      console.warn(`[afterTest] getUrl failed: ${String(error)}`)
    }

    // (b) Distilled page source — testids present + marker fragments only.
    let source = ''
    try {
      source = await browser.getPageSource()
    } catch (error) {
      console.warn(`[afterTest] getPageSource failed: ${String(error)}`)
    }
    if (source) {
      try {
        const testids = [
          ...new Set([...source.matchAll(/data-testid="([^"]*)"/g)].map((m) => m[1] ?? '')),
        ]
        console.warn(
          `[afterTest] data-testids present (${testids.length}): ${testids.join(', ').slice(0, DIAG_EXCERPT_CAP)}`,
        )
      } catch (error) {
        console.warn(`[afterTest] testid scan failed: ${String(error)}`)
      }
      try {
        // The specs' markers all start with "wdio", so text around every "wdio"
        // occurrence shows whether the marked block/tag rendered at all —
        // distinguishing "never committed" from "committed but text mismatch".
        const fragments = [
          ...new Set([...source.matchAll(/.{0,60}wdio.{0,60}/gis)].map((m) => m[0] ?? '')),
        ]
        const joined = fragments.join(' | ').slice(0, DIAG_EXCERPT_CAP)
        console.warn(`[afterTest] marker fragments: ${joined || '(none — no "wdio" text in DOM)'}`)
      } catch (error) {
        console.warn(`[afterTest] marker scan failed: ${String(error)}`)
      }
    }

    // (c) Sidebar innerHTML (capped) — the nav is where 4 specs failed.
    try {
      const sidebar = await $('[data-slot="sidebar"]')
      if (await sidebar.isExisting()) {
        const html = await sidebar.getHTML()
        console.warn(`[afterTest] sidebar HTML (capped): ${html.slice(0, DIAG_EXCERPT_CAP)}`)
      } else {
        console.warn('[afterTest] sidebar [data-slot="sidebar"] not present')
      }
    } catch (error) {
      console.warn(`[afterTest] sidebar HTML capture failed: ${String(error)}`)
    }
  },
}
