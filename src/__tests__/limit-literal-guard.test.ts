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
 *
 * Argument splitting goes through `js-scanner.mjs` (`findMatchingBracket` +
 * `splitTopLevelCommas`), never a local state machine. A hand-rolled splitter
 * is blind to regex literals — the `)` in `/[,)]/` decrements its depth and
 * every later argument shifts, so the guard reports a clean tree for a file it
 * did not parse. That is the fail-OPEN direction, and #3991 exists to stop a
 * fourth copy of this scanner appearing. `splitTopLevelCommas` throws
 * `ScanError` on undecidable input, so the test reddens rather than skipping.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped JS helper, the repo's sanctioned tokenizer (#3991)
import * as scanner from '../../scripts/lib/js-scanner.mjs'
import { walkFiles } from './helpers/walk-files'

/** `limit`'s positional index in each generated binding that takes one. */
function limitIndexByCommand(): Map<string, number> {
  // Through the scanner first: a parameter list carrying doc-comment parens
  // (`filteredBlocksQuery`'s does) is invisible to the `[^)]*` match below,
  // and a command the map silently lacks is a command the guard never checks.
  const bindings = scanner.stripComments(readFileSync('src/lib/bindings.ts', 'utf8')) as string
  const out = new Map<string, number>()
  for (const m of bindings.matchAll(/^\t(\w+): \(([^)]*)\) =>/gm)) {
    const params = (scanner.splitTopLevelCommas(m[2] ?? '') as string[]).map((p) =>
      (p.split(':')[0] ?? '').trim(),
    )
    const i = params.indexOf('limit')
    if (i !== -1) out.set(m[1] as string, i)
  }
  return out
}

describe('#4918 limit-literal guard', () => {
  it('no call site passes a bare number where a command takes a limit', () => {
    const limitIndex = limitIndexByCommand()
    // Fails closed, per command rather than per file: every generated binding
    // that names a `limit` parameter must be in the map, or it is a command
    // the guard silently never checks — and that looks identical to a clean
    // tree. (The raw bindings are the source of truth for "names a limit".)
    const raw = readFileSync('src/lib/bindings.ts', 'utf8')
    const namesALimit = [...raw.matchAll(/^\t(\w+): \(/gm)]
      .map((m) => m[1] as string)
      .filter((name) => {
        const start = raw.indexOf(`\t${name}: (`)
        const open = raw.indexOf('(', start)
        const close = scanner.findMatchingBracket(raw, open) as number
        return /\blimit\b/.test(scanner.stripComments(raw.slice(open, close)) as string)
      })
    expect([...limitIndex.keys()].toSorted()).toEqual(namesALimit.toSorted())

    const offenders: string[] = []
    for (const file of walkFiles(
      'src',
      (name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'),
    )) {
      // Tests may pass a raw limit on purpose — they are asserting what the
      // backend does with one.
      if (/__tests__|\.test\.tsx?$/.test(file)) continue
      const source = scanner.stripComments(readFileSync(file, 'utf8')) as string
      for (const [command, index] of limitIndex) {
        const call = new RegExp(`commands\\s*\\.\\s*${command}\\s*\\(`, 'g')
        for (const m of source.matchAll(call)) {
          const open = m.index + m[0].length - 1
          const close = scanner.findMatchingBracket(source, open) as number
          const args = scanner.splitTopLevelCommas(source.slice(open + 1, close)) as string[]
          const arg = (args[index] ?? '').trim()
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
