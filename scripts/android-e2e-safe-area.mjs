#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Android on-device e2e: the app must not occupy the system bars, and
// the header hamburger must actually be tappable (#4301).
//
// WHY THIS IS A DEVICE TEST AND NOT A VITEST/PLAYWRIGHT ONE
// ---------------------------------------------------------
// The bug this pins lives entirely BELOW the web layer. `targetSdk = 36`
// forces the activity edge-to-edge, so the webview is laid out at the full
// display size; the status bar window then sits above the app window in the
// z-order and swallows every touch in its strip. A jsdom test sees correct
// markup, and a Playwright/Chromium test sees a viewport that starts at the
// top of the window — because in a browser it does. Neither can observe an
// Android window inset, which is the only thing that was wrong.
//
// It also cannot be replaced by "screenshot the app and look at it": the
// system clock is drawn in the OS's own tint, and against a light app header
// in night mode it is white-on-white — visually absent while the status bar
// is in fact present and eating the taps. The regression is invisible to the
// eye and obvious to the accessibility tree, so that is what we assert on.
//
// WHAT IT ASSERTS
// ---------------
//   1. The webview's on-screen bounds sit inside the system-bar safe rect.
//   2. The hamburger's bounds sit inside that rect too — bounds that merely
//      LOOK right on screen are not enough, they must be out of the strip
//      the status bar window claims.
//   3. Tapping the hamburger at its real screen coordinates opens the nav
//      drawer. This is the user-visible claim, and it is the assertion that
//      cannot be satisfied by geometry that happens to be correct while the
//      touch target is not.
//
// Assertions 1 and 2 come from `adb shell dumpsys window`'s `InsetsState`,
// which is the window manager's own record — NOT anything the app reports
// about itself. A test that asked the app where it thought it was would pass
// on exactly the builds that are broken.
//
// Usage:
//   node scripts/android-e2e-safe-area.mjs [--apk <path>] [--serial <id>] [--pkg <id>]
//
// Requires a single connected, UNLOCKED device or emulator (or $ANDROID_SERIAL).
// Exits non-zero with a diagnosis on failure.
// ─────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * The application id to drive. Overridable with `--pkg` because a locally
 * built debug APK cannot be installed over a release-signed one without
 * uninstalling it first — and on a real device that wipes the user's notes.
 * Building the debug APK under a suffixed application id lets it sit beside
 * the real install instead. The Java package (and so the activity class) is
 * the namespace, which the suffix does not touch.
 */
let PKG = 'com.agaric.app'
const ACTIVITY_CLASS = 'com.agaric.app.MainActivity'

/** `t('sidebar.openMenu')` in `src/lib/i18n/common.ts` — the hamburger's aria-label. */
const MENU_LABEL = 'Open navigation menu'
/**
 * `t('sidebar.trash')`. The drawer-open marker has to be something that is
 * absent while the drawer is closed; the nav entries qualify and the sr-only
 * sheet title does not always surface as its own node.
 */
const DRAWER_MARKERS = ['Trash', 'Templates', 'Advanced Query']
/**
 * `t('gestures.coachmark.dismiss')` / `t('space.onboardingDismiss')`. A fresh
 * install opens on a modal onboarding dialog, which makes everything behind it
 * inert — including the hamburger, which then does not appear in the
 * accessibility tree at all. Left unhandled the test reports "the app never
 * rendered a menu control", which is true and useless: the app is fine and the
 * test is standing in front of a dialog. Dismissing it is part of driving the
 * app, not a workaround.
 */
const ONBOARDING_DISMISS = 'Got it'

const READY_TIMEOUT_MS = 40_000
const POLL_MS = 750

// ── adb plumbing ─────────────────────────────────────────────────────

let SERIAL = null

function adb(args, { allowFail = false } = {}) {
  const full = SERIAL ? ['-s', SERIAL, ...args] : args
  try {
    return execFileSync('adb', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    if (allowFail) return ''
    throw new Error(`adb ${full.join(' ')} failed: ${err.stderr || err.message}`)
  }
}

function fail(message, detail) {
  console.error(`\n✗ ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}

function resolveSerial(requested) {
  const listed = execFileSync('adb', ['devices'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0])

  if (requested) {
    if (!listed.includes(requested)) {
      fail(`device '${requested}' is not connected`, `connected: ${listed.join(', ') || '(none)'}`)
    }
    return requested
  }
  if (listed.length === 0)
    fail('no connected Android device or emulator', 'start one, then re-run.')
  if (listed.length > 1) {
    fail('more than one device connected', `pass --serial <id>; saw: ${listed.join(', ')}`)
  }
  return listed[0]
}

// ── system truth: where the system bars actually are ─────────────────

/**
 * Read the window manager's own inset bookkeeping.
 *
 * Mirrors what `WindowInsetsCompat.getInsets(systemBars() | displayCutout())`
 * computes natively: each visible source contributes to the edge named by its
 * `sideHint`, and the largest contribution per edge wins.
 */
function readSafeRect() {
  const dump = adb(['shell', 'dumpsys', 'window'])
  const start = dump.indexOf('WindowInsetsStateController')
  if (start < 0) fail('could not find WindowInsetsStateController in `dumpsys window`')
  const section = dump.slice(start)

  const frameMatch = section.match(/mDisplayFrame=Rect\((\d+), (\d+) - (\d+), (\d+)\)/)
  if (!frameMatch) fail('could not read mDisplayFrame from `dumpsys window`')
  const display = {
    width: Number(frameMatch[3]),
    height: Number(frameMatch[4]),
  }

  const wanted = new Set(['statusBars', 'navigationBars', 'displayCutout'])
  const inset = { left: 0, top: 0, right: 0, bottom: 0 }

  const re =
    /InsetsSource id=\S+ type=(\w+) frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\] visible=(true|false)[^\n]*?sideHint=(\w+)/g
  let m
  let sources = 0
  while ((m = re.exec(section)) !== null) {
    const [, type, l, t, r, b, visible, side] = m
    if (!wanted.has(type) || visible !== 'true') continue
    const rect = { left: +l, top: +t, right: +r, bottom: +b }
    // A zero-area source claims nothing.
    if (rect.right <= rect.left || rect.bottom <= rect.top) continue
    sources += 1
    if (side === 'TOP') inset.top = Math.max(inset.top, rect.bottom)
    else if (side === 'BOTTOM') inset.bottom = Math.max(inset.bottom, display.height - rect.top)
    else if (side === 'LEFT') inset.left = Math.max(inset.left, rect.right)
    else if (side === 'RIGHT') inset.right = Math.max(inset.right, display.width - rect.left)
  }
  if (sources === 0) {
    fail(
      'no visible system-bar inset sources found',
      'the device may be in an immersive/fullscreen state — this test needs the normal bars shown.',
    )
  }

  return {
    display,
    inset,
    safe: {
      left: inset.left,
      top: inset.top,
      right: display.width - inset.right,
      bottom: display.height - inset.bottom,
    },
  }
}

// ── app truth: where the app's views actually are ────────────────────

/** The package owning the focused window, per the window manager. */
function focusedPackage() {
  const m = adb(['shell', 'dumpsys', 'window'], { allowFail: true }).match(
    /mCurrentFocus=Window\{\S+ \S+ ([^\s/}]+)/,
  )
  return m ? m[1] : null
}

/** Parse `uiautomator dump` into flat nodes with parsed bounds. */
function dumpNodes() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/agaric-e2e.xml'], { allowFail: true })
  const xml = adb(['shell', 'cat', '/sdcard/agaric-e2e.xml'], { allowFail: true })
  const nodes = []
  for (const raw of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = raw[0]
    const attr = (name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? ''
    const b = tag.match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/)
    nodes.push({
      cls: attr('class'),
      desc: attr('content-desc'),
      text: attr('text'),
      pkg: attr('package'),
      bounds: b
        ? { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] }
        : { left: 0, top: 0, right: 0, bottom: 0 },
    })
  }
  return nodes
}

const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top)

function findMenuButton(nodes) {
  return nodes.find((n) => n.desc.trim() === MENU_LABEL && area(n.bounds) > 0) ?? null
}

function drawerIsOpen(nodes) {
  return nodes.some((n) => area(n.bounds) > 0 && DRAWER_MARKERS.includes((n.text || n.desc).trim()))
}

function hasOnboarding(nodes) {
  return nodes.some((n) => (n.text || n.desc).trim() === ONBOARDING_DISMISS && area(n.bounds) > 0)
}

/** Tap a first-run onboarding dialog away, if one is up. Returns true if it tapped. */
function dismissOnboarding(nodes) {
  const btn = nodes.find(
    (n) => (n.text || n.desc).trim() === ONBOARDING_DISMISS && area(n.bounds) > 0,
  )
  if (!btn) return false
  const cx = Math.round((btn.bounds.left + btn.bounds.right) / 2)
  const cy = Math.round((btn.bounds.top + btn.bounds.bottom) / 2)
  console.log(`dismissing a first-run '${ONBOARDING_DISMISS}' dialog at (${cx}, ${cy}) …`)
  adb(['shell', 'input', 'tap', String(cx), String(cy)])
  return true
}

/**
 * Wait until the app is settled on its own chrome with nothing modal over it.
 *
 * "The hamburger is in the tree" is necessary but NOT sufficient: the gesture
 * coach-mark opens from an effect a tick after the header renders, so a single
 * clean read can be taken in the gap before it appears. The tap then lands on
 * the dialog's overlay, dismisses it, and the drawer never opens — a real
 * failure of the test, reported as a failure of the app. Requiring two
 * CONSECUTIVE clean reads is what closes that window; one is a snapshot, two
 * spanning a poll interval is a state.
 */
async function waitForApp() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let nodes = []
  let clean = 0
  let sawDialog = false
  while (Date.now() < deadline) {
    nodes = dumpNodes()
    if (findMenuButton(nodes) && !hasOnboarding(nodes)) {
      clean += 1
      if (clean >= 2) return nodes
    } else {
      clean = 0
      // Onboarding dialogs can stack (gesture coach-mark, then space
      // onboarding), so this keeps clearing them rather than clearing one and
      // giving up.
      if (dismissOnboarding(nodes)) sawDialog = true
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  // Distinguish "the app is broken" from "something is standing in front of
  // it". A window owned by another package — the platform's 16 KB-alignment
  // warning for debuggable builds, a permission prompt, an ANR — hides the
  // app's whole hierarchy from `uiautomator dump` AND eats every injected tap.
  // Reporting that as "the app never rendered a control" sends the reader off
  // to debug an app that is working fine, which cost real time here.
  const front = focusedPackage()
  if (front && front !== PKG) {
    const dialogText = nodes
      .map((n) => (n.text || n.desc).trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(' | ')
    fail(
      `a window owned by '${front}' is in front of the app`,
      [
        `  it is hiding the app's hierarchy and swallowing injected taps.`,
        dialogText ? `  what it says: ${dialogText}` : '',
        '',
        `  Dismiss it on the device and re-run. If it is the platform's`,
        `  "Android app compatibility" warning, it only appears for DEBUGGABLE`,
        '  builds on a real device — "Don\'t show again" retires it for good.',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  fail(
    `the app never settled on a '${MENU_LABEL}' control within ${READY_TIMEOUT_MS / 1000}s`,
    sawDialog
      ? `a '${ONBOARDING_DISMISS}' dialog was dismissed but the app still never settled.`
      : 'the app may have failed to launch, or the label changed — check `adb logcat`.',
  )
}

const fmt = (r) => `[${r.left},${r.top}][${r.right},${r.bottom}]`

function assertInsideSafeRect(what, bounds, safe) {
  const bad =
    bounds.top < safe.top ||
    bounds.bottom > safe.bottom ||
    bounds.left < safe.left ||
    bounds.right > safe.right
  if (bad) {
    fail(
      `${what} overlaps a system bar`,
      [
        `  ${what} bounds: ${fmt(bounds)}`,
        `  system-bar safe rect: ${fmt(safe)}`,
        '',
        '  The app window is laid out edge-to-edge and nothing insets it, so app',
        '  content is drawn under the status/navigation bar. The status bar window',
        '  is above the app in the z-order, so it also eats touches in its strip.',
        '  See src-tauri/gen/android/app/src/main/java/com/agaric/app/MainActivity.kt.',
      ].join('\n'),
    )
  }
  console.log(`✓ ${what} is inside the safe rect ${fmt(safe)} (bounds ${fmt(bounds)})`)
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const apk = argv.includes('--apk') ? argv[argv.indexOf('--apk') + 1] : null
  const serialArg = argv.includes('--serial')
    ? argv[argv.indexOf('--serial') + 1]
    : process.env.ANDROID_SERIAL || null
  if (argv.includes('--pkg')) PKG = argv[argv.indexOf('--pkg') + 1]

  SERIAL = resolveSerial(serialArg)
  console.log(`device: ${SERIAL}`)

  if (apk) {
    if (!existsSync(apk)) fail(`APK not found: ${apk}`)
    console.log(`installing ${apk} …`)
    adb(['install', '-r', '-d', apk])
  }

  if (/mDreamingLockscreen=true/.test(adb(['shell', 'dumpsys', 'window'], { allowFail: true }))) {
    fail('the device is locked', 'unlock it and re-run — a locked device shows no app window.')
  }

  adb(['shell', 'am', 'force-stop', PKG])
  adb(['shell', 'am', 'start', '-n', `${PKG}/${ACTIVITY_CLASS}`])

  let nodes = await waitForApp()

  const { display, inset, safe } = readSafeRect()
  console.log(
    `display ${display.width}x${display.height}, system-bar insets ` +
      `l=${inset.left} t=${inset.top} r=${inset.right} b=${inset.bottom}`,
  )
  if (inset.top === 0 && inset.bottom === 0) {
    fail(
      'the device reports no system-bar insets at all',
      'nothing to assert — this test needs a device that shows a status/navigation bar.',
    )
  }

  // 1. The webview itself must be inset. Take the largest webview node: the
  //    hierarchy nests one inside the other.
  const webview = nodes
    .filter((n) => n.cls === 'android.webkit.WebView' && n.pkg === PKG)
    .toSorted((a, b) => area(b.bounds) - area(a.bounds))[0]
  if (!webview) fail('no android.webkit.WebView node found in the app hierarchy')
  assertInsideSafeRect('the webview', webview.bounds, safe)

  // 2. …and so must the control the user is trying to hit.
  const menu = findMenuButton(nodes)
  assertInsideSafeRect(`the '${MENU_LABEL}' button`, menu.bounds, safe)

  // 3. The geometry can be right while the tap still goes nowhere. Prove it.
  if (drawerIsOpen(nodes)) {
    fail(
      'the nav drawer was already open before the tap',
      'this test cannot distinguish a working tap from a pre-open drawer.',
    )
  }
  const cx = Math.round((menu.bounds.left + menu.bounds.right) / 2)
  const cy = Math.round((menu.bounds.top + menu.bounds.bottom) / 2)
  console.log(`tapping the hamburger at (${cx}, ${cy}) …`)
  adb(['shell', 'input', 'tap', String(cx), String(cy)])

  const deadline = Date.now() + 8000
  let opened = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    nodes = dumpNodes()
    if (drawerIsOpen(nodes)) {
      opened = true
      break
    }
  }
  if (!opened) {
    fail(
      'tapping the hamburger did not open the nav drawer',
      [
        `  tapped (${cx}, ${cy}); expected one of ${DRAWER_MARKERS.join(', ')} to appear.`,
        '',
        '  If the geometry assertions above passed, the touch is being consumed by',
        '  something drawn over the app rather than by a layout overlap.',
      ].join('\n'),
    )
  }
  console.log('✓ the nav drawer opened')

  adb(['shell', 'rm', '-f', '/sdcard/agaric-e2e.xml'], { allowFail: true })
  console.log('\n✓ android safe-area e2e passed')
}

await main()
