#!/usr/bin/env node
// Android on-device check: a block typed into today's journal survives
// `am force-stop` and a relaunch (#6553).
//
// The launch smoke proves a release build boots; it never writes anything, so
// a build that boots but cannot persist would ship. This types a run-scoped
// marker into the journal, kills the process, starts it again and fails unless
// the marker is back in the accessibility tree, which after a cold start can
// only come from what the app wrote to disk.
//
// The strings it drives on are English literals copied from
// `src/lib/i18n/common.ts`; a renamed value there, or a non-English device,
// fails this with a healthy app (the same caveat as `android-e2e-safe-area.mjs`).
//
// Run by `.github/workflows/android-launch-smoke.yml` after the launch smoke,
// which installs the APK. Needs one booted, unlocked device or emulator on adb.
//
// Usage: node scripts/android-e2e-persist.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const PKG = 'com.agaric.app'
const ACTIVITY = `${PKG}/${PKG}.MainActivity`
/** `t('action.addBlock')`: on a fresh day it focuses the day's empty seed block. */
const ADD_BLOCK = 'Add block'
/** `t('gestures.coachmark.dismiss')`: a fresh install opens on a modal coach-mark. */
const ONBOARDING_DISMISS = 'Got it'
const DUMP_PATH = '/sdcard/agaric-e2e-persist.xml'
const READY_TIMEOUT_MS = 40_000
const POLL_MS = 750
/**
 * Held between leaving the editor and the kill. The blur's save is an IPC with
 * nothing on screen to say it landed, and this also outlasts the draft
 * autosave's debounce (`DRAFT_DEBOUNCE_MS` in `src/hooks/useDraftAutosave.ts`),
 * so either save path has run.
 */
const SETTLE_MS = 5000
const KEYCODE_ESCAPE = '111'

function resolveAdb() {
  const home = process.env.ANDROID_HOME
  const sdkAdb = home ? join(home, 'platform-tools', 'adb') : ''
  return sdkAdb && existsSync(sdkAdb) ? sdkAdb : 'adb'
}

const ADB = resolveAdb()

function adb(args, { allowFail = false } = {}) {
  try {
    return execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    if (allowFail) return ''
    throw new Error(`adb ${args.join(' ')} failed: ${err.stderr || err.message}`)
  }
}

/** Sync write so the message lands before `process.exit` (see android-e2e-safe-area.mjs). */
function fail(message, detail) {
  adb(['shell', 'rm', '-f', DUMP_PATH], { allowFail: true })
  writeSync(2, `\n::error::${message}\n`)
  if (detail) writeSync(2, `${detail}\n`)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The app's on-screen nodes in a fresh `uiautomator dump`; other packages are
 * dropped, so a keyboard's suggestion strip echoing the marker cannot pass.
 * The previous dump is removed first, so a dump that fails reads as an empty
 * screen, which every caller treats as "not found", never as a stale pass.
 */
function dumpNodes() {
  adb(['shell', 'rm', '-f', DUMP_PATH], { allowFail: true })
  adb(['shell', 'uiautomator', 'dump', DUMP_PATH], { allowFail: true })
  const xml = adb(['shell', 'cat', DUMP_PATH], { allowFail: true })
  const nodes = []
  for (const [tag] of xml.matchAll(/<node\b[^>]*>/g)) {
    const attr = (name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? ''
    const b = tag.match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/)
    if (attr('package') !== PKG || !b || +b[3] <= +b[1] || +b[4] <= +b[2]) continue
    nodes.push({
      label: (attr('text') || attr('content-desc')).trim(),
      x: Math.round((+b[1] + +b[3]) / 2),
      y: Math.round((+b[2] + +b[4]) / 2),
    })
  }
  return nodes
}

function tap(node) {
  adb(['shell', 'input', 'tap', String(node.x), String(node.y)])
}

function screenText(nodes) {
  const labels = nodes.map((n) => n.label).filter(Boolean)
  return labels.length > 0
    ? labels.slice(0, 12).join(' | ')
    : `(no node of ${PKG} in the accessibility dump)`
}

/**
 * Poll until `found(nodes)` returns a node, tapping a first-run coach-mark
 * away on the way. Returns the node, or fails with what was on screen.
 */
async function waitFor(what, found) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let nodes = []
  while (Date.now() < deadline) {
    nodes = dumpNodes()
    const hit = found(nodes)
    if (hit) return hit
    const dismiss = nodes.find((n) => n.label === ONBOARDING_DISMISS)
    if (dismiss) tap(dismiss)
    await sleep(POLL_MS)
  }
  fail(`${what} within ${READY_TIMEOUT_MS / 1000}s`, `  on screen: ${screenText(nodes)}`)
}

function pidOf() {
  return adb(['shell', 'pidof', PKG], { allowFail: true }).trim()
}

async function main() {
  const marker = `agaricpersist${Date.now()}`
  const withMarker = (nodes) => nodes.find((n) => n.label.includes(marker))

  adb(['wait-for-device'])
  adb(['shell', 'am', 'force-stop', PKG])
  adb(['shell', 'am', 'start', '-W', '-n', ACTIVITY])

  // A seed block that opened in its editor is left first, so "Add block" is
  // the one way in, whichever state the journal started in.
  await waitFor(`the journal never showed '${ADD_BLOCK}'`, (nodes) =>
    nodes.find((n) => n.label === ADD_BLOCK),
  )
  adb(['shell', 'input', 'keyevent', KEYCODE_ESCAPE])
  tap(
    await waitFor(`'${ADD_BLOCK}' did not come back after leaving the editor`, (nodes) =>
      nodes.find((n) => n.label === ADD_BLOCK),
    ),
  )
  adb(['shell', 'input', 'text', marker])
  await waitFor(`the typed '${marker}' never appeared on screen`, withMarker)
  adb(['shell', 'input', 'keyevent', KEYCODE_ESCAPE])
  await sleep(SETTLE_MS)
  console.log(`typed '${marker}' into today's journal`)

  adb(['shell', 'am', 'force-stop', PKG])
  for (let t = 0; t < 10 && pidOf(); t++) await sleep(1000)
  const survivor = pidOf()
  if (survivor) fail(`${PKG} pid ${survivor} was still running 10s after am force-stop`)

  adb(['shell', 'am', 'start', '-W', '-n', ACTIVITY])
  await waitFor(`'${marker}' was not on screen after a force-stop and relaunch`, withMarker)
  adb(['shell', 'rm', '-f', DUMP_PATH], { allowFail: true })
  console.log(`OK: '${marker}' survived am force-stop and a relaunch`)
}

await main()
