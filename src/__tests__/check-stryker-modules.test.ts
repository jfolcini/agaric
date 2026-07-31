import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// #3330 — `stryker.modules.mjs` is the mutation lane's only source of truth
// for what gets mutated and which tests scope the run, and nothing verified
// its paths still exist. A moved `src` turns a module into a `| <mod> |
// _no report_ |` row in the weekly step summary; a test file that was never
// wired into `tests[]` makes the scoped run keep re-reporting already-killed
// mutants as survivors (the #3142 tree-utils incident: 78 reported, 22 real).
// These assertions live in the GATING vitest suite so a file move is caught
// on the PR that makes it, not by the following Monday's scheduled run.
const SCRIPT = join(__dirname, '../../scripts/check-stryker-modules.mjs')

describe('check-stryker-modules.mjs', () => {
  it('every path declared in stryker.modules.mjs exists on disk', () => {
    expect(() => execFileSync('node', [SCRIPT], { encoding: 'utf8' })).not.toThrow()
  })

  it('passes its own fixture suite (the guard can actually fail)', () => {
    const out = execFileSync('node', [SCRIPT, '--self-test'], { encoding: 'utf8' })
    expect(out).toContain('self-test: all assertions passed')
    expect(out).toContain('dangling src path is flagged')
    expect(out).toContain('dangling test path is flagged')
    // #3350 — the two assertions added when the module set widened. Named
    // individually rather than trusting the "all assertions passed" line,
    // which stays green if a fixture is deleted.
    expect(out).toContain('a misspelled module key is flagged (#3350)')
    expect(out).toContain("a module outside the PR lane's `paths:` filter is flagged (#3350)")
  })

  it('every enrolled module is reachable by the diff-scoped PR lane', () => {
    // #3350 — `mutation-pr.yml` only starts when a PR touches a path in its
    // `on.pull_request.paths` filter, which is a second encoding of the
    // module set. Enrolling a module under a tree that filter does not name
    // makes the lane silently never fire for it: no failing job, no empty
    // report, no workflow run at all. Gating, because the drift lands in a
    // PR and the consequence is invisible afterwards.
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
    expect(out).toMatch(/covered by \.github\/workflows\/mutation-pr\.yml's \d+ path filter\(s\)/)
  })

  it('exits non-zero when the declared paths do not resolve', () => {
    // End-to-end proof that the failure path is reachable: resolve the real
    // config against an empty root, so every declared path is missing. A
    // guard whose non-zero exit is never exercised is decoration.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'agaric-stryker-modules-'))
    let status: number | undefined
    let stderr = ''
    try {
      execFileSync('node', [SCRIPT, '--root', emptyRoot], { encoding: 'utf8', stdio: 'pipe' })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      status = e.status
      stderr = e.stderr ?? ''
    }
    expect(status).toBe(1)
    expect(stderr).toContain('declares a src path that does not exist')
    expect(stderr).toContain('problem(s) in stryker.modules.mjs')
  })
})
