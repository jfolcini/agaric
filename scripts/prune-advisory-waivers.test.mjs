// Tests for scripts/prune-advisory-waivers.mjs.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
// Every `describe()`/`it()` is `void`-ed: node:test's returned promise fulfils
// even when the test fails, so there is nothing to await.

import { parseUnused, pruneDeny, pruneNsprc, unusedFromReports } from './prune-advisory-waivers.mjs'

const DENY = `[advisories]
unused-ignored-advisory = "deny"
ignore = [
    # Tauri transitive deps.
    { id = "RUSTSEC-2024-0370", reason = "proc-macro-error" },
    { id = "RUSTSEC-2026-0592", reason = "url; the fix clears the gate on 2026-11-27" },
    { id = "RUSTSEC-2026-0594", reason = "cookie [vex:vulnerable_code_not_present]" },
]

[bans]
skip = [{ id = "RUSTSEC-2026-0592" }]
`

const NSPRC = `${JSON.stringify(
  {
    'GHSA-g3hv-75wg-m249': { active: true, notes: 'minimatch', expiry: '2026-12-10' },
    1234567: { active: true, notes: 'GHSA-aaaa-bbbb-cccc other' },
  },
  null,
  2,
)}\n`

void describe('unusedFromReports', () => {
  void it('reads the advisory-not-detected ids from cargo deny and unusedExceptionIds from better-npm-audit', () => {
    const diag = (code, span) =>
      JSON.stringify({
        type: 'diagnostic',
        fields: { code, labels: [{ span }, { span: 'reason' }], severity: 'error' },
      })
    const cargo = [
      diag('advisory-not-detected', 'RUSTSEC-2026-0592'),
      diag('vulnerability', 'url 2.5.8'),
      'not json: a progress line',
      JSON.stringify({ type: 'summary', fields: {} }),
    ].join('\n')
    const npm = JSON.stringify({ unusedExceptionIds: ['GHSA-g3hv-75wg-m249'] })
    assert.deepEqual(unusedFromReports(cargo, npm), {
      cargo: ['RUSTSEC-2026-0592'],
      npm: ['GHSA-g3hv-75wg-m249'],
    })
    assert.deepEqual(unusedFromReports('', ''), { cargo: [], npm: [] })
  })
})

void describe('parseUnused', () => {
  void it('accepts only advisory ids, so the artifact from a run of PR code is data', () => {
    assert.deepEqual(parseUnused('{"cargo":["RUSTSEC-2026-0592"],"npm":["1234567"]}'), {
      cargo: ['RUSTSEC-2026-0592'],
      npm: ['1234567'],
    })
    assert.throws(
      () => parseUnused('{"cargo":["RUSTSEC-2026-0592\\"]"],"npm":[]}'),
      /not an advisory id/,
    )
    assert.throws(
      () => parseUnused('{"cargo":["GHSA-g3hv-75wg-m249"],"npm":[]}'),
      /not an advisory id/,
    )
    assert.throws(() => parseUnused('{"cargo":"RUSTSEC-2026-0592","npm":[]}'), /not a list/)
    assert.throws(() => parseUnused('{"npm":[]}'), /not a list/)
  })
})

void describe('pruneDeny', () => {
  void it('deletes exactly the listed ignore lines and leaves every other byte', () => {
    const out = pruneDeny(DENY, ['RUSTSEC-2026-0592', 'RUSTSEC-2026-0594'])
    assert.equal(out, DENY.replace(/^ {4}\{ id = "RUSTSEC-2026-059[24]".*\n/gm, ''))
    assert.match(out, /skip = \[\{ id = "RUSTSEC-2026-0592" \}\]/)
  })

  void it('refuses an id it cannot find in [advisories].ignore', () => {
    assert.throws(() => pruneDeny(DENY, ['RUSTSEC-2020-0001']), /RUSTSEC-2020-0001 .*not/)
  })
})

void describe('pruneNsprc', () => {
  void it('deletes the listed keys and keeps every other entry as it was', () => {
    const out = JSON.parse(pruneNsprc(NSPRC, ['GHSA-g3hv-75wg-m249']))
    assert.deepEqual(out, { 1234567: { active: true, notes: 'GHSA-aaaa-bbbb-cccc other' } })
  })

  void it('refuses a key .nsprc does not hold', () => {
    assert.throws(() => pruneNsprc(NSPRC, ['7654321']), /7654321 .*not/)
  })
})
