import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error — no type declarations for the .mjs module registry.
import { MODULE_NAMES } from '../../stryker.modules.mjs'

// #5101 — the `mutants-frontend` lane ran green for weeks while its runner
// executed zero tests per mutant and reported every one survived. The #3330
// liveness guard keyed on mutant COUNT, which that failure leaves intact, so
// the guard now also fails a sweep in which nothing was killed.
const SCRIPT = join(__dirname, '../../scripts/check-mutation-reports.mjs')

function writeReports(statuses: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-reports-'))
  for (const mod of MODULE_NAMES) {
    mkdirSync(join(dir, mod))
    const mutants = statuses.map((status, i) => ({ id: String(i), status }))
    writeFileSync(join(dir, mod, 'mutation.json'), JSON.stringify({ files: { x: { mutants } } }))
  }
  return dir
}

function run(dir: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync('node', [SCRIPT, '--reports-dir', dir], { encoding: 'utf8' }),
    }
  } catch (err) {
    const e = err as { status: number; stderr: string }
    return { code: e.status, out: e.stderr }
  }
}

describe('check-mutation-reports.mjs', () => {
  it('passes a sweep with kills and survivors', () => {
    const { code, out } = run(writeReports(['Killed', 'Survived', 'NoCoverage']))
    expect(code).toBe(0)
    expect(out).toContain(`${MODULE_NAMES.length * 3} mutant(s) tested`)
  })

  it('fails a sweep in which every mutant survived (#5101)', () => {
    const { code, out } = run(writeReports(['Survived', 'Survived', 'NoCoverage']))
    expect(code).toBe(1)
    expect(out).toContain('not one was Killed or Timeout')
  })

  it('counts a Timeout as a kill', () => {
    expect(run(writeReports(['Timeout', 'Survived'])).code).toBe(0)
  })
})
