/**
 * #4918 — invariant 10's frontend half, after the wrapper layer that used to
 * carry it.
 *
 * A paginated IPC rejects an out-of-range `limit` with `AppError::Validation`,
 * and the frontend is supposed to never send one: a call site takes the
 * `SafeLimit` brand from `@/lib/safe-limit`, so the bounds check runs at the
 * call site instead of round-tripping a bad value to the backend.
 *
 * That was enforced by one thing — the hand-written `@/lib/tauri` wrappers
 * typed `limit` as `SafeLimit`, so `{ limit: 500 }` did not assign. #4411 is
 * retiring those wrappers, and the generated bindings type every `limit` as
 * plain `number | null`, so a direct `commands.*` call compiles with any
 * number. The defect that motivates this guard was in the tree when it was
 * written: `empty-block-cleanup.ts` passed a bare `1` to `getBacklinks`.
 *
 * WHAT THIS CATCHES, AND WHAT IT DOES NOT. It rejects a numeric LITERAL in a
 * `limit` slot — the documented anti-pattern. It cannot reject an unbounded
 * variable, because it reads text rather than types. Only branding the
 * generated `limit` parameter would do that, and specta cannot express a
 * nominal brand (`SafeLimit = number & {…}`) — it would take a post-processing
 * step over generated output. That trade is recorded on #4918 rather than
 * taken here.
 *
 * The command→argument-index map is DERIVED from `src/lib/bindings.ts`, never
 * hand-written: a second table is the drift this whole area exists to remove.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped JS helper, the repo's sanctioned tokenizer (#3991)
import { stripComments } from '../../scripts/lib/js-scanner.mjs'

/** `limit`'s positional index in each generated binding that takes one. */
function limitIndexByCommand(): Map<string, number> {
  const bindings = readFileSync('src/lib/bindings.ts', 'utf8')
  const out = new Map<string, number>()
  for (const m of bindings.matchAll(/^\t(\w+): \(([^)]*)\) =>/gm)) {
    const params = (m[2] ?? '').split(',').map((p) => (p.split(':')[0] ?? '').trim())
    const i = params.indexOf('limit')
    if (i !== -1) out.set(m[1] as string, i)
  }
  return out
}

/** Top-level split of a call's argument list, starting just past its `(`. */
function splitArgs(source: string): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    if (quote !== null) {
      current += c
      if (c === quote && source[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      current += c
      continue
    }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) {
      if (depth === 0) {
        args.push(current)
        return args
      }
      depth--
    }
    if (c === ',' && depth === 0) {
      args.push(current)
      current = ''
      continue
    }
    current += c
  }
  args.push(current)
  return args
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('#4918 limit-literal guard', () => {
  it('no call site passes a bare number where a command takes a limit', () => {
    const limitIndex = limitIndexByCommand()
    // Fails closed: a bindings file this cannot read means no command is
    // checked, which would look identical to a clean tree.
    expect(limitIndex.size).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of walk('src')) {
      // Tests may pass a raw limit on purpose — they are asserting what the
      // backend does with one.
      if (/__tests__|\.test\.tsx?$/.test(file)) continue
      const source = stripComments(readFileSync(file, 'utf8')) as string
      for (const [command, index] of limitIndex) {
        const call = new RegExp(`commands\\s*\\.\\s*${command}\\s*\\(`, 'g')
        for (const m of source.matchAll(call)) {
          const arg = (splitArgs(source.slice(m.index + m[0].length))[index] ?? '').trim()
          if (!/^-?\d[\d_]*$/.test(arg)) continue
          const line = source.slice(0, m.index).split('\n').length
          offenders.push(`${file}:${line} — commands.${command}(…, ${arg}, …)`)
        }
      }
    }

    expect(
      offenders,
      'A bare numeric `limit` reaches the backend unchecked and comes back as an ' +
        'AppError::Validation at runtime (AGENTS.md invariant 10). Wrap it: ' +
        '`safeLimit(n, MAX)` or a named cap from `@/lib/safe-limit`.',
    ).toEqual([])
  })
})
