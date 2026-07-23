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
import { mkdirSync } from 'node:fs'
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
  hostname: '127.0.0.1',
  port: 4444,

  specs: ['./e2e-tauri/**/*.e2e.ts'],
  maxInstances: 1,

  capabilities: [
    {
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
    timeout: 120_000,
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
    tauriDriver = spawn(tauriDriverPath, [], {
      stdio: [null, process.stdout, process.stderr],
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

  afterSession: () => {
    killTauriDriver()
  },

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
