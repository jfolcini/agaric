import assert from 'node:assert/strict'
import test from 'node:test'

import { scanLogcat } from './android-launch-smoke.mjs'

const START =
  '10-22 04:00:01.000  500  520 I ActivityTaskManager: START u0 {cmp=com.agaric.app/.MainActivity} from uid 2000'

// The 0.15.0 shape (session 1916): ndk_context initialised twice, then abort.
const CRASH_0_15_0 = [
  START,
  "10-22 04:00:02.100 4100 4100 E RustStdoutStderr: thread 'main' panicked at ndk-context: ndk_context was already initialized",
  '10-22 04:00:02.200 4100 4100 F libc    : Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 4100 (com.agaric.app), pid 4100 (com.agaric.app)',
].join('\n')

const HEALTHY = [
  START,
  '10-22 04:00:02.100 4100 4100 I RustStdoutStderr: log directory initialized',
  '10-22 04:00:03.000 4100 4100 I chromium: [INFO:CONSOLE] page loaded',
].join('\n')

void test('a 0.15.0-style abort log is reported with both the panic and the SIGABRT', () => {
  const { verified, findings } = scanLogcat(CRASH_0_15_0)
  assert.equal(verified, true)
  assert.deepEqual(
    findings.map((f) => f.name),
    ['Rust panic', 'SIGABRT'],
  )
})

void test('a Java crash is reported as FATAL EXCEPTION', () => {
  const log = [
    START,
    '10-22 04:00:02.100 4100 4100 E AndroidRuntime: FATAL EXCEPTION: main',
    '10-22 04:00:02.100 4100 4100 E AndroidRuntime: Process: com.agaric.app, PID: 4100',
  ].join('\n')
  assert.deepEqual(
    scanLogcat(log).findings.map((f) => f.name),
    ['FATAL EXCEPTION'],
  )
})

void test('a healthy launch log has no findings and is verified', () => {
  assert.deepEqual(scanLogcat(HEALTHY), { verified: true, findings: [] })
})

void test('"panicked" outside the Rust tag is not a Rust panic', () => {
  const log = `${START}\n10-22 04:00:02.100 900 900 I SomeOtherTag: nobody panicked here`
  assert.deepEqual(scanLogcat(log).findings, [])
})

void test('a log that never names the app is unverified, not clean', () => {
  assert.equal(scanLogcat('').verified, false)
  assert.equal(scanLogcat('10-22 04:00:01.000 1 1 I init: booted').verified, false)
})
