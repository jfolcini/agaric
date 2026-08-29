import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * compiler must not trust its own inference for that function. It is present
 * in oxlint 1.79.0, the version pinned in package.json and installed at
 * node_modules/.bin/oxlint — the binary this suite actually drives.
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
 * (measured in #4493; exact counts and the re-measurement method are in
 * docs/session-log/session-1437-the-lint-that-was-not-run.md) become
 * `react/refs` / `react/static-components` ERRORS at sites that carry no
 * suppression, because a suppression cannot be added while the masking holds
 * — `--report-unused-disable-directives-severity=error`, which `npm run
 * lint` and the prek `oxlint` hook both pass, reports it unused. Re-measure
 * and land the suppressions in the same commit as the bump.
 */

const OXLINT = join(__dirname, '../../node_modules/.bin/oxlint')
const CONFIG = join(__dirname, '../../.oxlintrc.json')

/** A hook that reads and writes a ref during render — two `react/refs` sites. */
const REF_READ_WRITE = `  const r = useRef(0)
  const prev = r.current
  r.current = x
`

function lint(files: Record<string, string>): { code: string; line: number; file: string }[] {
  const dir = mkdtempSync(join(tmpdir(), 'oxlint-suppression-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source)
    }
    // oxlint exits 1 when it reports errors, so `execFileSync` would throw on
    // the very fixtures that are supposed to produce findings. Read stdout
    // and classify from the JSON instead of from the status code.
    // `stdio: 'pipe'` (precedent: check-stryker-modules.test.ts) captures
    // both streams on the thrown error so a run that produced no JSON at all
    // can name its own cause below, instead of surfacing as `JSON.parse`'s
    // opaque `SyntaxError`. Two such failure modes matter here, and they
    // don't share a stream: oxlint missing from `node_modules/.bin` after a
    // fresh clone fails the spawn itself (no stdout, no stderr, just an
    // ENOENT message on the caught error), while oxlint rejecting the config
    // outright -- the failure mode `.oxlintrc.json`'s own comment warns
    // about for an unknown `react/*` rule name -- prints its "Rule '...' not
    // found" message to STDOUT, not stderr, and it is not JSON either. Both
    // are captured and reported below.
    let stdout = ''
    let stderr = ''
    let spawnMessage = ''
    try {
      stdout = execFileSync(OXLINT, ['-c', CONFIG, '-f', 'json', ...Object.keys(files)], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? ''
      spawnMessage = e.message
    }
    let parsed: {
      diagnostics: { code: string; filename: string; labels?: { span?: { line?: number } }[] }[]
    }
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(
        `oxlint (cwd ${dir}) produced no usable JSON output.\n` +
          `stdout: ${stdout || '(empty)'}\n` +
          `stderr: ${stderr || '(empty)'}\n` +
          `spawn error: ${spawnMessage || '(none)'}`,
      )
    }
    // Deduplicate by (file, rule, line): oxlint emits the same `react(refs)`
    // site more than once on some bodies — three copies of one line in the
    // fixture below, and three of one ref site in `src/hooks/useListStyles.ts`
    // in the real tree (no line number: it drifts, and the count is the
    // point). Counting raw diagnostics would make these assertions depend on
    // that quirk rather than on whether the rule ran. The filename is part
    // of the key -- and of the returned tuple -- because `lint()` takes a
    // multi-file `Record`: two fixture files with a finding on the same line
    // would otherwise collapse into one entry, silently dropping one of
    // them. ('does not collapse two files...' below pins this.)
    const seen = new Map<string, { code: string; line: number; file: string }>()
    for (const d of parsed.diagnostics) {
      const line = d.labels?.[0]?.span?.line ?? -1
      seen.set(`${d.filename}@${d.code}@${line}`, { code: d.code, line, file: d.filename })
    }
    return [...seen.values()]
  } finally {
    // Precedent: scripts/check-type-aware-liveness.mjs removes its fixture
    // dir in a `finally` too. Every call site here makes a fresh
    // `mkdtempSync` dir, and none of them were ever removed, leaking one per
    // `it()` on every vitest run across CI.
    rmSync(dir, { recursive: true, force: true })
  }
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
    const twoHooksSource = `import { useMemo, useRef } from 'react'
export function useAlpha(x: number): number {
${REF_READ_WRITE}  // oxlint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => x + prev, [])
}

export function useBeta(x: number): number {
${REF_READ_WRITE}  return prev
}
`
    // 1-based line number of the `useBeta` declaration, derived from the
    // source rather than hardcoded: `REF_READ_WRITE` is shared across five
    // fixtures in this file, so editing it (or the import line) shifts where
    // `useBeta` actually starts, and a hardcoded boundary would not notice.
    const betaDeclarationLine =
      twoHooksSource.split('\n').findIndex((line) => line.includes('function useBeta')) + 1
    expect(betaDeclarationLine).toBeGreaterThan(0) // fixture must still contain the marker

    const found = lint({ 'two-hooks.ts': twoHooksSource })
    const refs = found.filter((f) => f.code === 'react(refs)')
    expect(refs).toHaveLength(2)
    // Both survivors are inside `useBeta`, which starts after the directive.
    for (const r of refs) expect(r.line).toBeGreaterThan(betaDeclarationLine)
  })

  it('does not collapse two files that share a finding on the same line', () => {
    // #4493 review note 1: `lint()` accepts a multi-file `Record` but dedups
    // on `(file, rule, line)`. Before the filename joined that key, two
    // fixtures with a finding on the same line number would silently
    // collapse into one entry. Giving both files the IDENTICAL clean-fixture
    // body puts their `react(refs)` findings on the exact same line numbers,
    // which is the direct proof that they no longer collapse.
    const body = `import { useRef } from 'react'
export function useProbe(x: number): number {
${REF_READ_WRITE}  return prev
}
`
    const found = lint({ 'file-a.ts': body, 'file-b.ts': body })
    const refs = found.filter((f) => f.code === 'react(refs)')
    expect(refs).toHaveLength(4) // 2 sites * 2 files; a collapse would report fewer
    expect(refs.filter((r) => r.file === 'file-a.ts')).toHaveLength(2)
    expect(refs.filter((r) => r.file === 'file-b.ts')).toHaveLength(2)
  })
})
