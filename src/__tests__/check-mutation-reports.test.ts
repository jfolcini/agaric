import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error — no type declarations for the .mjs script.
import { analyzeReports } from '../../scripts/check-mutation-reports.mjs'

// #5101 — the `mutants-frontend` lane ran green while its runner executed
// zero tests per mutant and reported every one survived. The #3330 liveness
// guard keyed on mutant COUNT, which that failure leaves intact, so the guard
// now also fails a module that counted mutants and killed none. Per module:
// static mutants still died in a fresh process, so the sweep total was never
// zero during the outage.
function writeReports(statusesByModule: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-reports-'))
  for (const [mod, statuses] of Object.entries(statusesByModule)) {
    mkdirSync(join(dir, mod))
    const mutants = statuses.map((status, i) => ({ id: String(i), status }))
    writeFileSync(join(dir, mod, 'mutation.json'), JSON.stringify({ files: { x: { mutants } } }))
  }
  return dir
}

function analyze(statusesByModule: Record<string, string[]>): { problems: string[] } {
  return analyzeReports({
    reportsDir: writeReports(statusesByModule),
    moduleNames: Object.keys(statusesByModule),
  })
}

describe('analyzeReports', () => {
  it('passes a module with kills and survivors', () => {
    expect(analyze({ a: ['Killed', 'Survived', 'NoCoverage'] }).problems).toEqual([])
  })

  it('fails a module in which every mutant survived (#5101)', () => {
    const { problems } = analyze({ a: ['Survived', 'Survived', 'NoCoverage'] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(
      'module `a` counted 3 mutant(s) and not one was Killed or Timeout',
    )
  })

  it('fails the outage shape: one module still kills static mutants, another kills none', () => {
    const { problems } = analyze({ a: ['Killed', 'Survived'], b: ['Survived', 'Survived'] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('module `b`')
  })

  it('counts a Timeout as a kill', () => {
    expect(analyze({ a: ['Timeout', 'Survived'] }).problems).toEqual([])
  })
})
