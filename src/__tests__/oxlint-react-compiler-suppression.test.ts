import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * #4493 — oxlint's React Compiler rules go SILENT for a whole component or
 * hook when that function carries a disable directive naming one of the four
 * suppression rules, and the silence is indistinguishable from "clean".
 *
 * This is not a directive-scope defect and it is not fixable here: oxlint
 * ports `babel-plugin-react-compiler`'s suppression bailout verbatim (oxc
 * #24747), where an author-declared incomplete dependency array means the
 * compiler must not trust its own inference for that function. It is
 * unchanged in oxlint 1.80.0.
 *
 * What CAN be held is the reading of it. `.oxlintrc.json` enables
 * `react/rule-suppression` at `warn` so every bailed-out function is named on
 * every run; these fixtures pin the behaviour that makes that necessary, in
 * BOTH directions — the finding fires with no directive present, and the same
 * fixture with an unrelated directive added does not — because a one-armed
 * assertion could not tell the current behaviour from a fixed one.
 *
 * If the "masked" cases below ever start reporting `react(refs)`, oxlint has
 * changed and this is not a nuisance failure: the tree's 15 masked files
 * (measured in #4493) become ~34 `react/refs` / `react/static-components`
 * ERRORS at sites that carry no suppression, because a suppression cannot be
 * added while the masking holds — `--report-unused-disable-directives-severity=error`,
 * which `npm run lint` and the prek `oxlint` hook both pass, reports it
 * unused. Re-measure and land the suppressions in the same commit as the bump.
 */

const OXLINT = join(__dirname, '../../node_modules/.bin/oxlint')
const CONFIG = join(__dirname, '../../.oxlintrc.json')

/** A hook that reads and writes a ref during render — two `react/refs` sites. */
const REF_READ_WRITE = `  const r = useRef(0)
  const prev = r.current
  r.current = x
`

function lint(files: Record<string, string>): { code: string; line: number }[] {
  const dir = mkdtempSync(join(tmpdir(), 'oxlint-suppression-'))
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source)
  }
  // oxlint exits 1 when it reports errors, so `execFileSync` would throw on
  // the very fixtures that are supposed to produce findings. Read stdout and
  // classify from the JSON instead of from the status code.
  let stdout: string
  try {
    stdout = execFileSync(OXLINT, ['-c', CONFIG, '-f', 'json', ...Object.keys(files)], {
      cwd: dir,
      encoding: 'utf8',
    })
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
  const parsed = JSON.parse(stdout) as {
    diagnostics: { code: string; labels?: { span?: { line?: number } }[] }[]
  }
  // Deduplicate by (rule, line): oxlint emits the same `react(refs)` site more
  // than once on some bodies — three copies of one line in the fixture below,
  // and three of one ref site in `src/hooks/useListStyles.ts` in the real
  // tree (no line number: it drifts, and the count is the point). Counting raw
  // diagnostics would make these assertions depend on that quirk rather than
  // on whether the rule ran.
  const seen = new Map<string, { code: string; line: number }>()
  for (const d of parsed.diagnostics) {
    const line = d.labels?.[0]?.span?.line ?? -1
    seen.set(`${d.code}@${line}`, { code: d.code, line })
  }
  return [...seen.values()]
}

const codesOf = (found: { code: string }[]): string[] => found.map((f) => f.code)

describe('oxlint React Compiler suppression bailout (#4493)', () => {
  it('reports the ref read/write when the hook carries no directive', () => {
    // The positive arm, and the probe that the linter can still fail at all:
    // every "masked" assertion below is only meaningful because this one
    // produces findings from the identical body.
    const found = lint({
      'clean.ts': `import { useRef } from 'react'
export function useProbe(x: number): number {
${REF_READ_WRITE}  return prev
}
`,
    })
    expect(codesOf(found).filter((c) => c === 'react(refs)')).toHaveLength(2)
    expect(codesOf(found)).not.toContain('react(rule-suppression)')
  })

  it('goes silent on the SAME body once the hook carries an exhaustive-deps directive', () => {
    // Same two ref sites, and they sit ABOVE the directive: the bailout covers
    // the enclosing function, not the next line.
    const found = lint({
      'masked.ts': `import { useMemo, useRef } from 'react'
export function useProbe(x: number): number {
${REF_READ_WRITE}  // oxlint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => x + prev, [])
}
`,
    })
    expect(codesOf(found)).not.toContain('react(refs)')
    // ...and the silence is announced rather than left to be inferred. This is
    // the assertion `.oxlintrc.json`'s `react/rule-suppression: warn` exists
    // to make true; dropping the rule there fails here.
    expect(codesOf(found)).toContain('react(rule-suppression)')
  })

  it('masks under the `eslint-` spelling too, which a grep for `oxlint-disable` misses', () => {
    // How `src/components/query/QueryResult.tsx` escaped the first pass of the
    // #4493 measurement. Any inventory of affected files must match both.
    const found = lint({
      'eslint-spelling.ts': `import { useMemo, useRef } from 'react'
export function useProbe(x: number): number {
${REF_READ_WRITE}  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => x + prev, [])
}
`,
    })
    expect(codesOf(found)).not.toContain('react(refs)')
    expect(codesOf(found)).toContain('react(rule-suppression)')
  })

  it('does not mask for a directive naming an unrelated rule', () => {
    // The trigger is the RULE NAMED, not the presence of a directive: only
    // the four React Compiler suppression rules bail the compiler out. Without
    // this arm, "masked" above would be consistent with any directive
    // silencing the file, which is what #4493 originally suspected.
    const found = lint({
      'unrelated.ts': `import { useRef } from 'react'
export function useProbe(x: number): number {
${REF_READ_WRITE}  // oxlint-disable-next-line eslint/no-console
  console.log(prev)
  return prev
}
`,
    })
    expect(codesOf(found).filter((c) => c === 'react(refs)')).toHaveLength(2)
    expect(codesOf(found)).not.toContain('react(rule-suppression)')
  })

  it('scopes the bailout to the suppressed function, not the file', () => {
    // A file-wide bailout and a function-wide one look the same on a
    // single-hook fixture. `useBeta` is what tells them apart, and it is why
    // the blast radius is counted in functions rather than in files.
    const found = lint({
      'two-hooks.ts': `import { useMemo, useRef } from 'react'
export function useAlpha(x: number): number {
${REF_READ_WRITE}  // oxlint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => x + prev, [])
}

export function useBeta(x: number): number {
${REF_READ_WRITE}  return prev
}
`,
    })
    const refs = found.filter((f) => f.code === 'react(refs)')
    expect(refs).toHaveLength(2)
    // Both survivors are inside `useBeta`, which starts after the directive.
    for (const r of refs) expect(r.line).toBeGreaterThan(7)
  })
})
