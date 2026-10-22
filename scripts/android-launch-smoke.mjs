#!/usr/bin/env node
// Launch smoke for a release-profile Android APK on an emulator (#6050).
//
// 0.15.0 crashed on every Android launch (Tauri 2.12 initialised `ndk_context`
// twice under `panic = "abort"`) with CI green: nothing launched a release
// build. This installs the APK, starts the main activity, holds for a few
// seconds, and fails when the process died or logcat shows a crash.
//
// A debug build unwinds on panic and would not reproduce the abort, so the
// caller must hand this a release-profile APK (`.github/workflows/android-launch-smoke.yml`).
//
// Usage: node scripts/android-launch-smoke.mjs <apk> [--wait <seconds>]
// Needs one booted device or emulator on adb.

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const PKG = 'com.agaric.app'
const ACTIVITY = `${PKG}/${PKG}.MainActivity`
const DEFAULT_WAIT_S = 25
/** The process must show up this fast after `am start`, or it never started. */
const APPEAR_S = 15
const TAIL_LINES = 150

/** One predicate per crash shape the brief names; the name is what the failure prints. */
const CRASH_SHAPES = [
  { name: 'FATAL EXCEPTION', matches: (line) => line.includes('FATAL EXCEPTION') },
  { name: 'SIGABRT', matches: (line) => line.includes('SIGABRT') },
  // `RustStdoutStderr` is the app's own tag; under panic = "abort" the panic
  // message is the last thing it prints before the abort.
  {
    name: 'Rust panic',
    matches: (line) => line.includes('RustStdoutStderr') && line.includes('panicked'),
  },
]

/**
 * Scan a `logcat -d` dump.
 *
 * Fails closed: a dump with no line naming the app proves nothing about the
 * app (an empty buffer, the wrong device, a cleared log), so `verified` is
 * false and the caller must treat that as a failure, not as "no crash found".
 */
export function scanLogcat(text) {
  const lines = text.split('\n')
  const findings = []
  let sawApp = false
  for (const line of lines) {
    if (line.includes(PKG)) sawApp = true
    for (const shape of CRASH_SHAPES) {
      if (shape.matches(line)) findings.push({ name: shape.name, line: line.trim() })
    }
  }
  return { verified: sawApp, findings }
}

function resolveAdb() {
  const home = process.env.ANDROID_HOME
  const sdkAdb = home ? join(home, 'platform-tools', 'adb') : ''
  return sdkAdb && existsSync(sdkAdb) ? sdkAdb : 'adb'
}

const ADB = resolveAdb()

function adb(args) {
  return execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** Sync write so the message lands before `process.exit` (see android-e2e-safe-area.mjs). */
function fail(message, detail) {
  writeSync(2, `\n::error::${message}\n`)
  if (detail) writeSync(2, `${detail}\n`)
  process.exit(1)
}

function pidOf() {
  try {
    return adb(['shell', 'pidof', PKG]).trim()
  } catch {
    // `pidof` exits 1 when there is no such process.
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tail(text) {
  return text.split('\n').slice(-TAIL_LINES).join('\n')
}

function parseArgs(argv) {
  let apk = ''
  let waitS = DEFAULT_WAIT_S
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wait') {
      waitS = Number(argv[++i])
    } else if (!apk) {
      apk = argv[i]
    } else {
      fail(`unexpected argument '${argv[i]}'`, 'usage: android-launch-smoke.mjs <apk> [--wait <s>]')
    }
  }
  if (!apk || !Number.isInteger(waitS) || waitS < 1) {
    fail('usage: android-launch-smoke.mjs <apk> [--wait <seconds>]')
  }
  return { apk, waitS }
}

async function main() {
  const { apk, waitS } = parseArgs(process.argv.slice(2))
  if (!existsSync(apk)) fail(`APK not found: ${apk}`)

  adb(['wait-for-device'])
  console.log(`installing ${apk}`)
  adb(['install', '-r', apk])
  adb(['logcat', '-c'])

  const started = adb(['shell', 'am', 'start', '-W', '-n', ACTIVITY])
  if (/^Error/m.test(started)) fail(`am start failed for ${ACTIVITY}`, started)

  // The pid is read once and must stay the same: a crash followed by the
  // system relaunching the activity would otherwise look alive.
  let pid = ''
  for (let t = 0; t < APPEAR_S && !pid; t++) {
    pid = pidOf()
    if (!pid) await sleep(1000)
  }
  let death = ''
  if (!pid) {
    death = `${PKG} never appeared within ${APPEAR_S}s of am start`
  } else {
    for (let t = 0; t < waitS && !death; t++) {
      await sleep(1000)
      const now = pidOf()
      if (now !== pid) death = `${PKG} pid ${pid} became '${now || 'none'}' within ${waitS}s`
    }
  }

  const log = adb(['logcat', '-d', '-v', 'threadtime'])
  const { verified, findings } = scanLogcat(log)
  if (death || findings.length > 0 || !verified) {
    const reasons = [
      ...(death ? [death] : []),
      ...findings.map((f) => `${f.name}: ${f.line}`),
      ...(verified ? [] : [`logcat never mentions ${PKG}, so nothing was verified`]),
    ]
    fail(
      `Android launch smoke failed:\n  ${reasons.join('\n  ')}`,
      `----- last logcat lines -----\n${tail(log)}`,
    )
  }
  console.log(`OK: ${PKG} stayed up (pid ${pid}) for ${waitS}s with no crash in logcat`)
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) await main()
