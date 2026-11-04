import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { frontendKey } from './lib/mutation-accepted.mjs'
import { renderMutationSummary } from './render-mutation-summary.mjs'

const FILE = 'src/lib/sample.ts'
const SOURCE = [
  'export function f(a, b) {',
  '  if (a === null) return b',
  "  return a ?? ''",
  '}',
].join('\n')

const mutant = (status, line, column, mutatorName) => ({
  status,
  mutatorName,
  location: { start: { line, column }, end: { line, column: column + 1 } },
})

/**
 * One module's report: three killed, two survivors on line 2 and a no-coverage
 * mutant on line 3. The returned `accept` writes `mutation-accepted.tsv` entries
 * for the listed mutants, fingerprinted as `--accept` does.
 */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'render-mutation-summary-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reportsDir = join(dir, 'reports')
  mkdirSync(join(reportsDir, 'sample'), { recursive: true })
  const mutants = {
    survivedA: mutant('Survived', 2, 7, 'ConditionalExpression'),
    survivedB: mutant('Survived', 2, 13, 'EqualityOperator'),
    noCoverage: mutant('NoCoverage', 3, 15, 'StringLiteral'),
  }
  const killed = [1, 2, 3].map((i) => mutant('Killed', 1, i, 'BlockStatement'))
  writeFileSync(
    join(reportsDir, 'sample', 'mutation.json'),
    JSON.stringify({
      files: { [FILE]: { source: SOURCE, mutants: [...killed, ...Object.values(mutants)] } },
    }),
  )
  const acceptedPath = join(dir, 'mutation-accepted.tsv')
  const accept = (...names) => {
    const lines = SOURCE.split('\n')
    const entries = names.map((name) => {
      const m = mutants[name]
      return frontendKey(FILE, m.mutatorName, lines, m.location.start.line, m.location.start.column)
    })
    writeFileSync(acceptedPath, ['# reason', ...entries, ''].join('\n'))
  }
  return { reportsDir, acceptedPath, accept }
}

void test('accepted-equivalent mutants are left out of the counts, the score and the list', (t) => {
  const { reportsDir, acceptedPath, accept } = fixture(t)
  accept('survivedA', 'noCoverage')

  const md = renderMutationSummary({ reportsDir, title: '### Results', acceptedPath })

  // 3 killed / (3 killed + 1 survivor): the accepted survivor leaves the denominator.
  assert.match(md, /^\| sample \| 75\.0% \| 3 \| 0 \| 1 \| 0 \| 0 \|$/m)
  assert.match(
    md,
    /^\| \*\*All mutated modules\*\* \| \*\*75\.0%\*\* \| 3 \| 0 \| 1 \| 0 \| 0 \|$/m,
  )
  assert.match(md, /2 accepted-equivalent mutant\(s\) in `mutation-accepted\.tsv` are left out/)
  assert.ok(md.includes(`${FILE}:2 [EqualityOperator]`), md)
  assert.ok(!md.includes(`${FILE}:2 [ConditionalExpression]`), md)
})

void test('with no entry matching, every survivor and no-coverage mutant is reported', (t) => {
  const { reportsDir, acceptedPath, accept } = fixture(t)
  accept()

  const md = renderMutationSummary({ reportsDir, title: '### Results', acceptedPath })

  assert.match(md, /^\| sample \| 60\.0% \| 3 \| 0 \| 2 \| 1 \| 0 \|$/m)
  assert.ok(!md.includes('accepted-equivalent'), md)
})

void test('an unreadable accepted file subtracts nothing and says so', (t) => {
  const { reportsDir, acceptedPath } = fixture(t)
  writeFileSync(acceptedPath, 'not an entry\n')

  const md = renderMutationSummary({ reportsDir, title: '### Results', acceptedPath })

  assert.match(md, /^\| sample \| 60\.0% \| 3 \| 0 \| 2 \| 1 \| 0 \|$/m)
  assert.match(
    md,
    /`mutation-accepted\.tsv` could not be read \(.*not an accepted-equivalent entry/,
  )
})
