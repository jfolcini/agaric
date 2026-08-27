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

/**
 * Directory name for the session-level log rescue (see `rescueAppLogs`
 * below); never a spec title. Declared here, ahead of `sanitizeForFilename`,
 * so that function can reserve it — see its doc comment.
 */
export const SESSION_LOG_LABEL = 'session'

/**
 * Make a string safe as a single path segment.
 *
 * `.` survives the character filter (a spec title may legitimately contain
 * one), so the all-dots cases are rejected explicitly: this value is used as a
 * DIRECTORY name by `rescueAppLogs`, not only as a filename, and a segment of
 * `.` or `..` traverses instead of naming. Not reachable from this repo's own
 * spec titles today — which is exactly why it is worth pinning before some
 * future title makes it reachable.
 *
 * `SESSION_LOG_LABEL` is reserved for the same directory-collision reason:
 * `rescueAppLogs` is idempotent per label (#4428), so a per-test label that
 * sanitized to exactly `SESSION_LOG_LABEL` would let a per-test `afterTest`
 * call claim that directory first, and the SESSION-level `afterSession`
 * rescue — the more complete one, taken after the driver is killed — would
 * then be skipped as "already rescued" (#4457). Unlike the `.`/`..` case
 * above, this ONE IS reachable from an ordinary spec title: a root-level test
 * titled "session" (no enclosing `describe`, so `test.parent` is `''`)
 * sanitizes to exactly that string. Suffixed rather than rejected, so the
 * function still returns something legible for a screenshot/log-dir name.
 *
 * NOT collision-proof (#4477 note 1): the suffix, `session-test`, is itself
 * an ORDINARY reachable label — exactly what `describe('session')` +
 * `it('test')` sanitizes to with no reservation involved, since this
 * function is already many-to-one (any run of characters outside
 * `[a-zA-Z0-9._-]` collapses to one hyphen). Whichever of those two shapes'
 * `afterTest` call fires first still claims `app-logs/session-test`
 * idempotently, and the other is skipped as "already rescued" — the same
 * failure mode this reservation exists to close, one level removed. Strictly
 * better than the bug fixed here (that one swallowed the MORE COMPLETE
 * session-level rescue; this one is between two ordinary per-test rescues,
 * and needs both specific shapes present in the same run) and consistent
 * with this function's existing many-to-one behaviour elsewhere, so it is
 * documented rather than treated as closed. A collision-proof reservation is
 * possible in principle — pick a `SESSION_LOG_LABEL` this function can PROVE
 * no title can ever produce, e.g. one with a leading/trailing hyphen or
 * composed only of dots, both already structurally impossible outputs of
 * `truncated` above — but `SESSION_LOG_LABEL` names the real on-disk CI
 * artifact directory and is pinned by literal value in
 * `e2e-tauri/session-log-label.test.ts`, so changing it is a deliberate,
 * reviewed decision, not a drive-by. See that file's last test for the
 * concrete demonstration.
 */
export function sanitizeForFilename(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'failure'
  const truncated = cleaned.slice(0, 120)
  return truncated === SESSION_LOG_LABEL ? `${truncated}-test` : truncated
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
 * What a failing WDIO wait was watching, recovered from its own message.
 *
 * Two things travel together here because separating them is what makes the
 * verdict wrong. WDIO puts only `this.selector` in the message, which for a
 * CHAINED lookup (`row.$('[data-testid="task-marker"]')`) is the CHILD half
 * alone — the parent scope is NOT recoverable from the text. And the message
 * names the state that was awaited, which is not always `displayed`.
 */
export interface WaitFailure {
  /** Verbatim from the message; possibly only the child half of a chain. */
  selector: string
  /**
   * The state WDIO was waiting for, verbatim: `displayed`,
   * `displayed within viewport`, `clickable`, `enabled` or `existing`. Carried
   * into the verdict so a `clickable` failure can never be answered with a
   * `displayed` verdict — the whole point of this diagnostic is to name which
   * half failed, and naming the wrong half is worse than staying silent.
   */
  waitedFor: string
}

/**
 * Recover the selector AND the awaited state from a failing WDIO wait message.
 *
 * WDIO renders these as `element ("<selector>") still not <state> after Nms`
 * (the five templates live in webdriverio/build/node.js). THIS IS AN INPUT
 * CONTRACT WITH A DEPENDENCY, not a fact about our code, and every test below
 * feeds a hand-written message — so the pin is here rather than in an
 * assertion that could only agree with itself. Read verbatim out of the
 * INSTALLED `webdriverio` 9.31.1 bundle (`node_modules/webdriverio/build/
 * node.js`, the `waitForClickable`/`waitForDisplayed`/`waitForEnabled`/
 * `waitForExist` command bodies), against `"@wdio/cli": "^9.31.1"` in
 * package.json:
 *
 *     `element ("${this.selector}") still ${reverse ? '' : 'not '}` +
 *       `displayed${withinViewport ? ' within viewport' : ''} after ${timeout}ms`
 *
 * If a `@wdio/*` bump rewords that template this parser stops matching and the
 * lane degrades to "failure is not an element wait — no visibility probe":
 * safe, silent, and it re-opens the ambiguity #4428 exists to close. A red
 * weekly run whose log says that for an obvious `waitForDisplayed` timeout is
 * the symptom; re-read the template at the path above before touching the
 * regex. The selector
 * routinely contains `"` (every `[data-testid="…"]`), so the capture is GREEDY
 * and pinned between ` still not ` and the ` after <n>ms` tail — neither of
 * which a selector can contain. Returns `undefined` for any other failure (a
 * plain `expect`, a `waitUntil` with a custom `timeoutMsg`, a `waitForStable`,
 * whose stability this probe cannot speak to at all), which is the signal to
 * skip the probe rather than guess.
 *
 * `displayed within viewport` is matched FIRST and kept WHOLE: WDIO appends it
 * inside the same template (`displayed${withinViewport ? ' within viewport' : ''}`),
 * and it is a strictly stronger assertion than `displayed`. Collapsing the two
 * would let the verdict answer a question that was never asked.
 *
 * Reverse waits render as `still <state>` with no `not`; that is deliberately
 * unmatched, because every verdict below would come out inverted.
 */
export function parseWaitFailure(message: string): WaitFailure | undefined {
  const match =
    /element \("(.+)"\) still not (displayed within viewport|displayed|clickable|enabled|existing) after \d+ms/.exec(
      message,
    )
  const selector = match?.[1]
  const waitedFor = match?.[2]
  if (selector === undefined || waitedFor === undefined) return undefined
  return { selector, waitedFor }
}

/** Flat by design: a discriminated union buys nothing across the wire. */
export interface VisibilityProbe {
  status: 'absent' | 'present' | 'unsupported-selector'
  /**
   * How many nodes in the WHOLE document match. The probe can only resolve
   * document-wide — WDIO's message does not carry the parent of a chained
   * lookup — so this is the only honest measure of how far the resolution
   * could have missed by. `> 1` means it read the FIRST of several.
   */
  matchCount: number
  width: number
  height: number
  /** Human-readable: every node on the ancestor chain that hides the element. */
  hiddenBy: string[]
  /**
   * `element.checkVisibility({ opacityProperty: true, visibilityProperty: true })`
   * VERBATIM — the engine's own answer, reported ALONGSIDE `hiddenBy` and never
   * folded into it. `hiddenBy` is a four-property reimplementation of a
   * question the engine already answers; where the two disagree, the
   * disagreement is the single most useful thing this probe can print, because
   * it means "hidden by something the walk does not model". `null` when the
   * engine does not implement `checkVisibility`.
   */
  checkVisibility: boolean | null
  /**
   * Whether the element's box INTERSECTS the viewport at all. `null` when the
   * box is zero-size, where the question is meaningless.
   */
  inViewport: boolean | null
  /**
   * Facts bearing on `clickable`/`enabled` that visibility does not cover:
   * `pointer-events:none` on the chain, `[disabled]`/`aria-disabled`, and what
   * the hit test at the element's centre actually lands on. Facts only — the
   * verdict that uses them lives in `explainVisibilityProbe`, and only for the
   * verbs they apply to.
   */
  blockedBy: string[]
}

/**
 * Runs IN THE PAGE. Walks from the element to the document root and reports
 * every node whose computed style takes the element off screen, plus the
 * engine's own `checkVisibility()` answer to compare it against.
 *
 * Ancestors matter as much as the element: `opacity`, `display` and
 * `visibility` are all inherited-in-effect for hit/visibility testing, and it
 * is precisely an ANCESTOR that hid the tag. Reporting only the element's own
 * style would have reproduced the original misdiagnosis.
 *
 * WDIO selectors are not all CSS (`button*=Add Tag`, `.//button[…]`), so an
 * invalid `querySelector` argument is reported as such rather than thrown —
 * this is diagnostics, and diagnostics may never become the failure. Every
 * optional capability below is behind a `try`/feature check for the same
 * reason.
 */
export function probeVisibilityInPage(selector: string): VisibilityProbe {
  // Every helper below is NESTED on purpose: `browser.execute` ships this
  // function to the page as source text, so a reference to anything at module
  // scope would be `undefined` there.
  const nothing = (status: 'absent' | 'unsupported-selector'): VisibilityProbe => ({
    status,
    matchCount: 0,
    width: 0,
    height: 0,
    hiddenBy: [],
    checkVisibility: null,
    inViewport: null,
    blockedBy: [],
  })

  let matches: ArrayLike<Element>
  try {
    matches = document.querySelectorAll(selector)
  } catch {
    return nothing('unsupported-selector')
  }
  const element: Element | undefined = matches[0]
  if (element === undefined) return nothing('absent')

  const describe = (node: Element): string => {
    const testid = node.getAttribute('data-testid')
    const cls = node.getAttribute('class') ?? ''
    const shortCls = cls.length > 100 ? `${cls.slice(0, 100)}…` : cls
    const testidPart = testid === null ? '' : ` data-testid="${testid}"`
    const classPart = shortCls === '' ? '' : ` class="${shortCls}"`
    return `<${node.tagName.toLowerCase()}${testidPart}${classPart}>`
  }

  const hiddenBy: string[] = []
  const blockedBy: string[] = []
  let node: Element | null = element
  let depth = 0
  while (node) {
    const where = depth === 0 ? 'the element itself' : `ancestor ${depth} level(s) up`
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
      hiddenBy.push(`${where} ${describe(node)} — ${reasons.join(', ')}`)
    }
    // Not a hiding reason: a `pointer-events:none` element is fully VISIBLE
    // and merely un-hittable, so it belongs to the interaction verbs only.
    if (style.pointerEvents === 'none') {
      blockedBy.push(`${where} ${describe(node)} — pointer-events:none`)
    }
    node = node.parentElement
    depth += 1
  }

  if (element.hasAttribute('disabled')) {
    blockedBy.push('the element itself carries the [disabled] attribute')
  }
  if (element.getAttribute('aria-disabled') === 'true') {
    blockedBy.push('the element itself carries aria-disabled="true"')
  }

  /** What the hit test at the element's centre lands on, if not the element. */
  const centrePointFact = (rect: DOMRect): string | undefined => {
    const centreX = Math.round(rect.left + rect.width / 2)
    const centreY = Math.round(rect.top + rect.height / 2)
    if (centreX < 0 || centreY < 0) return undefined
    if (centreX >= window.innerWidth || centreY >= window.innerHeight) return undefined
    try {
      const hit = document.elementFromPoint(centreX, centreY)
      if (hit === null || hit === element || element.contains(hit)) return undefined
      return (
        `the hit test at its centre point (${centreX},${centreY}) lands on ${describe(hit)}, ` +
        'which is neither the element nor a descendant of it'
      )
    } catch {
      // An engine without `elementFromPoint` simply contributes no fact.
      return undefined
    }
  }

  /** The engine's own verdict, reported verbatim — `null` if it has none. */
  const askEngine = (): boolean | null => {
    try {
      const engineCheck = (
        element as Element & {
          checkVisibility?: (options?: {
            opacityProperty?: boolean
            visibilityProperty?: boolean
          }) => boolean
        }
      ).checkVisibility
      if (typeof engineCheck !== 'function') return null
      return engineCheck.call(element, { opacityProperty: true, visibilityProperty: true })
    } catch {
      return null
    }
  }

  const rect = element.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)

  // A zero-size box has no meaningful centre and no meaningful intersection,
  // so the geometry questions are simply not asked rather than guessed at.
  let inViewport: boolean | null = null
  if (width > 0 && height > 0) {
    inViewport =
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    const covered = centrePointFact(rect)
    if (covered !== undefined) blockedBy.push(covered)
  }

  return {
    status: 'present',
    matchCount: matches.length,
    width,
    height,
    hiddenBy,
    checkVisibility: askEngine(),
    inViewport,
    blockedBy,
  }
}

/**
 * Turn a probe into the few sentences a reader of a red run needs, which are
 * always an answer to "is the asserted state missing, or merely invisible?" —
 * for the state that was ACTUALLY awaited.
 *
 * Four rules govern every branch, all of them learned the expensive way:
 *
 *   1. The verdict answers `wait.waitedFor`, never a state the probe finds
 *      easier to measure. A `clickable` wait gets no `displayed` verdict.
 *   2. Where the probe cannot decide, it SAYS SO. "No verdict" costs a reader
 *      nothing; a confident wrong verdict costs them the three weeks that
 *      #4428 cost, only pointed the other way.
 *   3. Anything resting on a document-wide `querySelector` of a possibly-child
 *      selector carries the scope caveat. `absent` is the one exception, and
 *      only because a scoped lookup can match nothing a document-wide one
 *      misses.
 *   4. ONE message carries exactly ONE verdict. The probe's facts co-occur
 *      freely — a `[disabled]` button inside a `display:none` container is
 *      both hidden and blocked — so where several could each be called a
 *      cause, VISIBILITY WINS and the rest are printed as additional facts
 *      under it. Two verdicts in one message ("RENDERING failure" followed by
 *      "INTERACTION failure rather than a rendering one") is rule 2's failure
 *      wearing a disguise: it reads as confidence and leaves the reader with
 *      exactly the ambiguity this function exists to remove.
 */
export function explainVisibilityProbe(wait: WaitFailure, probe: VisibilityProbe): string {
  const head = `[afterTest] why "${wait.selector}" never became ${wait.waitedFor}:`

  if (probe.status === 'unsupported-selector') {
    return `${head} not a CSS selector, so the DOM probe could not resolve it (no verdict).`
  }
  if (probe.status === 'absent') {
    return (
      `${head} NO element in the document matches it. A scoped lookup can only match a SUBSET of a ` +
      'document-wide one, so this verdict is immune to the chained-selector problem: the asserted ' +
      'state is genuinely MISSING — the failure the spec exists to catch, not a rendering artefact.'
    )
  }

  const engineSays =
    probe.checkVisibility === null ? 'unavailable' : `${String(probe.checkVisibility)}`
  const parts: string[] = [
    `${head} an element matching it IS in the DOM — ${probe.width}x${probe.height}px, ` +
      `${probe.matchCount} document-wide match(es), engine checkVisibility()=${engineSays}.`,
  ]

  // `existing` is not a visibility question at all: a hidden element still
  // exists, so the hiding walk cannot explain this failure and must not try.
  if (wait.waitedFor === 'existing') {
    parts.push(
      'This wait was for `existing`, which hiding does not affect — a hidden element still exists. ' +
        'So there are exactly two readings, and the probe cannot choose between them: the node was ' +
        'attached AFTER the wait expired (a TIMING failure), or the probe resolved a DIFFERENT node ' +
        'than the assertion did (see the caveat).',
    )
    if (probe.hiddenBy.length > 0) {
      parts.push(`For reference only, it is currently hidden by ${probe.hiddenBy.join('; ')}.`)
    }
    parts.push(scopeCaveat(probe))
    return parts.join(' ')
  }

  const interactionWait = wait.waitedFor === 'clickable' || wait.waitedFor === 'enabled'

  if (probe.hiddenBy.length > 0) {
    parts.push(
      `HIDDEN BY ${probe.hiddenBy.join('; ')}. The asserted state EXISTS — this is a RENDERING ` +
        'failure in whatever owns that node, NOT a failure of the feature under test.',
    )
    if (probe.checkVisibility === true) {
      parts.push(
        'DISAGREEMENT: the engine reports checkVisibility()=true while this walk found a hiding ' +
          'node. The engine is the authority WDIO itself consults — treat the walk entry as a lead, ' +
          'not as the verdict.',
      )
    }
  } else if (probe.checkVisibility === false) {
    parts.push(
      'DISAGREEMENT — and this is the useful part: nothing this walk models (display, visibility, ' +
        "opacity, content-visibility) hides it, yet the engine's own checkVisibility() says NOT " +
        'visible. Something the walk does NOT model is hiding it — a zero-size or clipping ' +
        '`overflow:hidden` ancestor, an off-screen transform, a sub-threshold opacity. Still a ' +
        'RENDERING failure; the walk simply cannot name the node.',
    )
  } else if (probe.width === 0 || probe.height === 0) {
    parts.push(
      `Nothing hides it, but its box is ${probe.width}x${probe.height}px — it is laid out to zero size.`,
    )
  } else {
    // From here on, `probe.checkVisibility` is either `true` (the engine
    // actively agrees) or `null` (this engine implements no `checkVisibility`
    // at all — see `askEngine` above; already excluded is `false`, handled
    // above). #4457 note 1: the three branches below used to read
    // `checkVisibility !== false` as "the engine agrees it is visible" — a
    // DENY-list that silently folded "no opinion" into "agrees". With such
    // an engine the walk's own facts (nothing hiding it, a real box) are the
    // ONLY evidence, yet the message asserted corroboration it never
    // obtained, and then — in the branch below with no other verdict to
    // give — committed to "A TIMING failure, not a state failure" on the
    // strength of that phantom agreement. Classified POSITIVELY instead:
    // only `true` counts as agreement, so `null` today — and any value this
    // scan has not anticipated tomorrow — reads as "no opinion", never as
    // silent corroboration.
    const engineAgrees = probe.checkVisibility === true

    if (wait.waitedFor === 'displayed within viewport' && probe.inViewport === false) {
      parts.push(
        engineAgrees
          ? 'Nothing hides it and the engine agrees it is visible, but its box does not intersect ' +
              'the viewport — the `within viewport` half of the assertion is what failed, not ' +
              'visibility.'
          : 'Nothing hides it, but the engine has no opinion (checkVisibility unavailable), so the ' +
              'visibility half rests on the walk alone; its box does not intersect the viewport — ' +
              'the `within viewport` half of the assertion is what failed regardless.',
      )
    } else if (interactionWait) {
      parts.push(
        engineAgrees
          ? `Nothing hides it and the engine agrees it is visible — but this wait was for ` +
              `\`${wait.waitedFor}\`, which visibility does not decide.`
          : `Nothing hides it, but the engine has no opinion (checkVisibility unavailable), so this ` +
              `rests on the walk alone — and this wait was for \`${wait.waitedFor}\`, which ` +
              'visibility does not decide either way.',
      )
    } else if (engineAgrees) {
      parts.push(
        `Nothing hides it, the engine agrees it is visible, and it is ${probe.width}x${probe.height}px ` +
          'RIGHT NOW — it reached the asserted state after the wait expired. A TIMING failure, not a ' +
          'state failure.',
      )
    } else {
      // #4457 acceptance: the null branch must not print a verdict. With no
      // `checkVisibility` there is no corroboration for "TIMING, not state" —
      // only the walk's say-so, which the `checkVisibility === false` branch
      // above already establishes can miss a real hiding cause. So this says
      // NO VERDICT rather than picking one of the two readings for the
      // reader.
      parts.push(
        `NO VERDICT: nothing this walk models hides it, and it is ${probe.width}x${probe.height}px ` +
          'RIGHT NOW, but the engine has no opinion (checkVisibility unavailable) — this rests on ' +
          'the walk alone, which cannot rule out an unmodeled rendering cause the way ' +
          '`checkVisibility()` can. Reaching the asserted state late and an unmodeled rendering ' +
          'cause are both still on the table, and nothing here decides between them.',
      )
    }
  }

  if (interactionWait) {
    // An element that is not visible is not clickable and not enabled either,
    // so where the visibility branches above already found a cause, that cause
    // IS the answer — printing "no verdict" underneath it would read as a
    // contradiction of the sentence directly before it.
    const visibilityAlreadyExplains =
      probe.hiddenBy.length > 0 ||
      probe.checkVisibility === false ||
      probe.width === 0 ||
      probe.height === 0
    // This test comes FIRST, ahead of `blockedBy`, and that order is the whole
    // point of the branch (rule 2). The two are not mutually exclusive — a
    // `[disabled]` button inside a `display:none` container has both a hiding
    // ancestor and an interaction fact — and the block above has, by then,
    // already printed "this is a RENDERING failure ... NOT a failure of the
    // feature under test". Reaching the `blockedBy` arm from that state
    // appended "this reads as an INTERACTION failure rather than a rendering
    // one" directly underneath it: one message, two verdicts, pointing
    // opposite ways, which is precisely the ambiguity this diagnostic exists to
    // remove. The interaction facts are still worth printing in that state —
    // but as ADDITIONAL facts under the rendering verdict, never as a rival to
    // it.
    if (visibilityAlreadyExplains) {
      parts.push(
        `That is on its own enough to fail a \`${wait.waitedFor}\` wait — an element that is not ` +
          'visible is neither clickable nor enabled — so no separate interaction cause is needed.',
      )
      // The facts the two arms below would have printed are not discarded with
      // the verdict they carried: only the VERDICT is suppressed here.
      const alsoBearing = [...probe.blockedBy]
      if (probe.inViewport === false) {
        alsoBearing.push('its box does not intersect the viewport')
      }
      if (alsoBearing.length > 0) {
        parts.push(
          `ADDITIONALLY, bearing on \`${wait.waitedFor}\`: ${alsoBearing.join('; ')}. Reported as ` +
            'extra facts, NOT as a competing verdict: each of these can fail the wait on its own, but ' +
            'the rendering cause named above is already sufficient, so fix that first and re-run ' +
            'before reading anything into these.',
        )
      }
    } else if (probe.blockedBy.length > 0) {
      parts.push(
        `BEARING ON \`${wait.waitedFor}\`: ${probe.blockedBy.join('; ')}. Each of these can fail the ` +
          'wait on an element that is fully visible, so this reads as an INTERACTION failure rather ' +
          'than a rendering one.',
      )
    } else if (probe.inViewport === false) {
      parts.push(
        `BEARING ON \`${wait.waitedFor}\`: its box does not intersect the viewport, so nothing can ` +
          'be clicked there without scrolling first.',
      )
    } else {
      parts.push(
        `NO VERDICT on \`${wait.waitedFor}\`: the probe checked pointer-events, [disabled], ` +
          'aria-disabled, the viewport and the hit test at the centre point, and found none of them ' +
          `blocking. That rules those five out and NOTHING more — it does not model every input of ` +
          `\`${wait.waitedFor}\`.`,
      )
    }
  }

  parts.push(scopeCaveat(probe))
  return parts.join(' ')
}

/**
 * The qualification every `present` verdict has to carry.
 *
 * WDIO's timeout message contains `this.selector` and nothing else, so for
 * `row.$('[data-testid="task-marker"]')` (reserved-property-roundtrip.e2e.ts)
 * the probe sees only the child half and resolves it across the WHOLE
 * document. If that row's marker never rendered while any other block on the
 * page has one, the probe reads a real element that the assertion was never
 * about. The parent scope is not recoverable from the text, so the honest move
 * is to state the exposure rather than invent a scope.
 */
function scopeCaveat(probe: VisibilityProbe): string {
  if (probe.matchCount > 1) {
    return (
      `CAVEAT: ${probe.matchCount} nodes in the document match this selector and the probe read the ` +
      'FIRST. WDIO reports only `this.selector`, which for a chained lookup (`row.$(…)`) is the child ' +
      'half alone, so the parent scope is unrecoverable — this may well not be the node the assertion ' +
      'targeted, and the verdict above is only as good as that guess.'
    )
  }
  return (
    'CAVEAT: the probe resolved this selector document-wide, and WDIO reports only `this.selector`, ' +
    'which for a chained lookup (`row.$(…)`) is the child half alone. This is *a* matching node, not ' +
    'provably the one the assertion targeted.'
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

/** Labels already copied by `rescueAppLogs` in this process. See below. */
const rescuedLogLabels = new Set<string>()

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
 *
 * Called from BOTH `afterTest` (per failing test) and `afterSession` (once per
 * session, under `SESSION_LOG_LABEL`), which is the only call that can fire for
 * the failures this exists for: `afterTest` never runs when the failure is in
 * `beforeSession`/`before` or when the app never boots at all. IDEMPOTENT per
 * label — a label already copied in this process is reported and skipped, so
 * the extra call site can neither duplicate work nor half-overwrite a copy that
 * is already sitting in the artifact directory.
 */
function rescueAppLogs(label: string): string {
  if (rescuedLogLabels.has(label)) {
    return `already rescued under "${label}" earlier in this session — not copying again.`
  }
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
  rescuedLogLabels.add(label)
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

  // -------------------------------------------------------------------------
  // The SESSION-level log rescue (#4428) — the one that covers the failures
  // `afterTest` structurally cannot.
  //
  // `afterTest` runs per test, so a session that never reaches a test never
  // calls it: a panic during boot (the 08-17 run — `SetLoggerError`, all 6
  // workers dead, not one test completed), or the 120s `notes.db` timeout in
  // the `before` hook above. Those are exactly the runs where the backend's own
  // log is the ONLY evidence that exists — the screenshot, the page source and
  // the visibility probe all need a live session, and there is none. Until this
  // call the sandbox holding that log was deleted here, unconditionally,
  // seconds after it was written.
  //
  // Two properties this must keep, in order:
  //
  //   * `removeSandbox()` runs from `finally`, so a rescue that throws can
  //     never leak the throwaway vault. Diagnostics that leak sandbox
  //     directories are a worse trade than no diagnostics — the leak is
  //     permanent litter in `$TMPDIR`, the missing log costs one re-run.
  //   * `rescueAppLogs` is idempotent per label, so this call and every
  //     `afterTest` call coexist without duplicating or half-overwriting a
  //     copy. This one uses its own label rather than a spec title, and
  //     `sanitizeForFilename` RESERVES that exact string (see its doc
  //     comment) — so a per-test label can never sanitize to it and steal
  //     this rescue's directory out from under it (#4457).
  // -------------------------------------------------------------------------
  afterSession: () => {
    killTauriDriver()
    try {
      console.warn(`[afterSession] app logs: ${rescueAppLogs(SESSION_LOG_LABEL)}`)
    } catch (error) {
      console.warn(`[afterSession] app log rescue failed: ${String(error)}`)
    } finally {
      removeSandbox()
    }
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
  // failing test this captures: (a) a screenshot, (a2) the VISIBILITY VERDICT
  // for the element the wait was watching — "missing" vs "merely invisible",
  // #4428 — (a3) the app's own `agaric.log*` copied out of the sandbox before
  // `afterSession` deletes it, (b) a DISTILLED page-source excerpt (the set of
  // `data-testid`s present + text fragments around every "wdio" marker — NOT
  // the full HTML), and (c) the current URL and the sidebar's innerHTML. Each
  // capture is independently try/caught: a diagnostics failure must never mask
  // the real test failure or abort teardown.
  //
  // (a3) is ALSO taken once per session from `afterSession` above, because this
  // hook does not run at all when the failure precedes the first test.
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
      const wait = parseWaitFailure(message)
      if (wait === undefined) {
        console.warn('[afterTest] failure is not an element wait — no visibility probe.')
      } else {
        const probe = await browser.execute(probeVisibilityInPage, wait.selector)
        console.warn(explainVisibilityProbe(wait, probe))
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
