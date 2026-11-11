#!/usr/bin/env node
// Names every test a nextest run passed only on a retry (#6553).
//
// `retries` in `src-tauri/.config/nextest.toml`'s `ci` profile turns a test
// that fails once and then passes into a green run, and the only trace was a
// FLAKY line in the job log. This reads the JUnit report that profile writes
// and prints a Markdown list of those tests for the job summary, so each one
// has a name a tracker can collect.
//
// In nextest's JUnit a flaky test is a <testcase> with one <flakyFailure> or
// <flakyError> per failed attempt; a test that failed every attempt carries
// <failure> and <rerunFailure> instead and is reported by the run itself.
// The report is machine-written and every text node in it is escaped, so a
// tag scanner reads it without a parser dependency.
//
// A report that is missing, truncated or empty is an error, never "no flaky
// tests". Finding flaky tests is not: the run's own result decides the job.
//
// Usage: node scripts/nextest-flaky-report.mjs <junit.xml>... >> "$GITHUB_STEP_SUMMARY"

import { existsSync, readFileSync, realpathSync } from 'node:fs'

const TAG =
  /<(\/?)(testsuites|testsuite|testcase|flakyFailure|flakyError)((?:\s+[^\s=/>]+="[^"]*")*)\s*(\/?)>/g
const ATTR = /([^\s=]+)="([^"]*)"/g
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** quick-xml, which writes nextest's report, escapes with these five only. */
function decode(text) {
  return text.replaceAll(/&(lt|gt|amp|quot|apos);/g, (_, e) => ENTITY[e])
}

function attributes(raw) {
  return Object.fromEntries([...raw.matchAll(ATTR)].map(([, k, v]) => [k, decode(v)]))
}

/**
 * Every testcase in one nextest JUnit report, and the ones that passed only
 * on a retry. Throws on a report it cannot vouch for.
 */
export function findFlakyTests(xml, path) {
  if (!/<testsuites[\s>]/.test(xml) || !xml.includes('</testsuites>')) {
    throw new Error(`${path}: not a complete nextest JUnit report (no <testsuites> element)`)
  }
  let tests = 0
  let current = null
  const flaky = []
  for (const [, closing, tag, rawAttrs, selfClosing] of xml.matchAll(TAG)) {
    if (tag === 'testcase') {
      if (closing) {
        current = null
        continue
      }
      tests++
      const { name, classname } = attributes(rawAttrs)
      if (!name) throw new Error(`${path}: a <testcase> has no name`)
      current = selfClosing ? null : { binary: classname ?? '', name, failedAttempts: 0 }
      if (current) flaky.push(current)
    } else if (tag === 'flakyFailure' || tag === 'flakyError') {
      if (closing) continue
      if (!current) throw new Error(`${path}: a <${tag}> sits outside a testcase`)
      current.failedAttempts++
    }
  }
  if (tests === 0) throw new Error(`${path}: the report holds no testcase`)
  return { tests, flaky: flaky.filter((t) => t.failedAttempts > 0) }
}

/** The job-summary Markdown for one or more reports' findings. */
export function renderFlakyReport(results) {
  const tests = results.reduce((n, r) => n + r.tests, 0)
  const flaky = results.flatMap((r) => r.flaky)
  if (flaky.length === 0) return `### Flaky tests: none of ${tests} passed only on a retry\n`
  const lines = [`### Flaky tests: ${flaky.length} of ${tests} passed only on a retry`, '']
  for (const t of flaky) {
    const attempts = `${t.failedAttempts} attempt${t.failedAttempts === 1 ? '' : 's'}`
    lines.push(`- \`${t.binary}\` \`${t.name}\`: failed ${attempts}, then passed`)
  }
  return `${lines.join('\n')}\n`
}

function main(paths) {
  if (paths.length === 0) throw new Error('usage: nextest-flaky-report.mjs <junit.xml>...')
  const results = paths.map((p) => {
    if (!existsSync(p))
      throw new Error(`${p}: no JUnit report (did nextest run with --profile ci?)`)
    return findFlakyTests(readFileSync(p, 'utf8'), p)
  })
  process.stdout.write(renderFlakyReport(results))
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`nextest-flaky-report: ${err.message}`)
    process.exit(1)
  }
}
