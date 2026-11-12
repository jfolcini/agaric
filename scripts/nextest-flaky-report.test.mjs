import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findFlakyTests, renderFlakyReport } from './nextest-flaky-report.mjs'

// The shape nextest's JUnit reporter (quick-junit) writes for `retries = 2`:
// a test that failed once and then passed is a <testcase> with one
// <flakyFailure> per failed attempt; a test that failed every attempt carries
// <failure> plus <rerunFailure>, and is not flaky. The failure output inside
// <system-err> is escaped text, including a tag-shaped line that must not
// read as a testcase.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="4" failures="1" errors="0" uuid="0b4f8e3a-5c0e-4f3e-9d43-3a1c1d2b8f10" timestamp="2026-11-11T04:17:00.000+00:00" time="12.345">
    <testsuite name="agaric-engine" tests="2" disabled="0" errors="0" failures="0">
        <testcase name="materializer::handlers::tag_convergence_tests::tags_converge_after_concurrent_edits" classname="agaric-engine" timestamp="2026-11-11T04:17:01.000+00:00" time="1.204">
            <flakyFailure timestamp="2026-11-11T04:17:00.100+00:00" time="0.902" type="test failure">thread &apos;main&apos; panicked at agaric-engine/src/materializer/handlers/tag_convergence_tests.rs:88:5
                <system-out>
running 1 test
</system-out>
                <system-err>assertion \`left == right\` failed
  left: 1
 right: 2
&lt;testcase name=&quot;not_a_test&quot;&gt;&lt;flakyFailure&gt;
</system-err>
            </flakyFailure>
        </testcase>
        <testcase name="op_log::tests::append_only_rejects_mutation" classname="agaric-engine" timestamp="2026-11-11T04:17:01.500+00:00" time="0.012"/>
    </testsuite>
    <testsuite name="agaric::command_integration" tests="2" disabled="0" errors="0" failures="1">
        <testcase name="sync::quic_round_trip_&lt;two_peers&gt;" classname="agaric::command_integration" timestamp="2026-11-11T04:17:02.000+00:00" time="3.100">
            <flakyError timestamp="2026-11-11T04:16:58.000+00:00" time="60.001" type="test timeout"></flakyError>
            <flakyFailure timestamp="2026-11-11T04:16:59.000+00:00" time="0.500" type="test failure">panicked</flakyFailure>
        </testcase>
        <testcase name="conformance::always_red" classname="agaric::command_integration" timestamp="2026-11-11T04:17:05.000+00:00" time="0.200">
            <failure type="test failure">thread &apos;main&apos; panicked</failure>
            <rerunFailure timestamp="2026-11-11T04:17:05.300+00:00" time="0.200" type="test failure">panicked</rerunFailure>
            <rerunFailure timestamp="2026-11-11T04:17:05.600+00:00" time="0.200" type="test failure">panicked</rerunFailure>
        </testcase>
    </testsuite>
</testsuites>
`

const GREEN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="1" failures="0" errors="0">
    <testsuite name="agaric-core" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="ulid::tests::uppercase" classname="agaric-core" time="0.001"/>
    </testsuite>
</testsuites>
`

void test('names every test that failed an attempt and then passed, and no other', () => {
  const { tests, flaky } = findFlakyTests(SAMPLE, 'junit.xml')
  assert.equal(tests, 4)
  assert.deepEqual(flaky, [
    {
      binary: 'agaric-engine',
      name: 'materializer::handlers::tag_convergence_tests::tags_converge_after_concurrent_edits',
      failedAttempts: 1,
    },
    {
      binary: 'agaric::command_integration',
      name: 'sync::quic_round_trip_<two_peers>',
      failedAttempts: 2,
    },
  ])
})

void test('the summary lists each flaky test by binary and name', () => {
  const md = renderFlakyReport([findFlakyTests(SAMPLE, 'junit.xml')])
  assert.match(md, /^### Flaky tests: 2 of 4 passed only on a retry$/m)
  assert.match(
    md,
    /^- `agaric-engine` `materializer::handlers::tag_convergence_tests::tags_converge_after_concurrent_edits`: failed 1 attempt, then passed$/m,
  )
  assert.match(
    md,
    /^- `agaric::command_integration` `sync::quic_round_trip_<two_peers>`: failed 2 attempts, then passed$/m,
  )
  assert.doesNotMatch(md, /always_red|not_a_test|append_only/)
})

void test('a run with no flaky test says so with its test count', () => {
  assert.equal(
    renderFlakyReport([findFlakyTests(GREEN, 'junit.xml')]),
    '### Flaky tests: none of 1 passed only on a retry\n',
  )
})

void test('a report it cannot read is an error, never "no flaky tests"', () => {
  assert.throws(() => findFlakyTests('', 'junit.xml'), /junit\.xml: not a complete nextest/)
  assert.throws(
    () => findFlakyTests(SAMPLE.slice(0, SAMPLE.indexOf('</testsuites>')), 'junit.xml'),
    /not a complete nextest/,
  )
  assert.throws(
    () => findFlakyTests('<testsuites tests="0"></testsuites>', 'junit.xml'),
    /holds no testcase/,
  )
  assert.throws(
    () =>
      findFlakyTests(
        '<testsuites><testsuite name="a"><flakyFailure/></testsuite></testsuites>',
        'junit.xml',
      ),
    /outside a testcase/,
  )
})

void test('the CLI exits 1 on a missing report and prints the summary for a real one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nextest-flaky-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const report = join(dir, 'junit.xml')
  writeFileSync(report, SAMPLE)
  const script = join(import.meta.dirname, 'nextest-flaky-report.mjs')

  const out = execFileSync(process.execPath, [script, report], { encoding: 'utf8' })
  assert.match(out, /^### Flaky tests: 2 of 4 passed only on a retry$/m)

  assert.throws(
    () => execFileSync(process.execPath, [script, join(dir, 'absent.xml')], { stdio: 'pipe' }),
    (err) => err.status === 1 && /absent\.xml/.test(String(err.stderr)),
  )
  assert.throws(
    () => execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    (err) => err.status === 1,
  )
})
