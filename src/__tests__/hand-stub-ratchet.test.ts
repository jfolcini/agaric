/**
 * #4668 — the hand-stubbed `invoke` ratchet.
 *
 * Counts test files that hand the INVOKE mock a literal — `.mockResolvedValue(…)`
 * / `.mockRejectedValue(…)` (and the `Once` variants) on `vi.mocked(invoke)` or
 * an alias bound to it. That literal is what nothing checks against the Rust
 * surface: a component can be green for years against a response the backend
 * never produces. Route a file's last literal through `mockInvokeCommands` and
 * it drops out, because that seam is typed against the generated return types.
 *
 * Not the count of files containing `vi.mocked(invoke)`: `mockInvokeCommands`
 * returns an implementation you still install, so a migrated file keeps that
 * string and the number could only fall by deleting tests.
 *
 * The baseline is the FILE SET, not its size. A count alone is satisfied by a
 * PR that migrates one file and adds a hand-stub in another — the arithmetic
 * that hid a regression behind a win. Naming the files also makes the
 * migration auditable in the diff, and it is what the retired
 * `tauri-import-baseline` ratchet (#2927) did for the wrapper layer.
 *
 * The match is textual, so the source goes through `js-scanner.mjs`'s
 * `stripComments` first (the sanctioned tokenizer) and the walk is fenced to
 * `*.test.ts(x)`: strings survive `stripComments` by design, and
 * `helpers/invoke.ts` names the expression in an error message.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped JS helper, the repo's sanctioned tokenizer (#3991)
import { stripComments } from '../../scripts/lib/js-scanner.mjs'
import { walkFiles } from './helpers/walk-files'

/**
 * Files that hand the invoke mock a literal because they SHOULD, keyed to why.
 *
 * Zero is not the target. These do not migrate — ever.
 * A test needing an ARBITRARY response — a malformed payload, a command with
 * no binding to be typed against — is testing a shape the typed seam exists to
 * forbid, and routing it through that seam would destroy it.
 *
 * An IPC REJECTION is not in this class: `mockInvokeCommands` takes a handler
 * that rejects or throws, so those migrate like any other stub.
 */
const DELIBERATE_EXCEPTIONS: readonly string[] = [
  // The seam under test. Its counted stub is a catch-all resolving `undefined`,
  // installed to prove that an explicit stub overrides `strictInvokeFallback` —
  // the case the whole design turns on. Expressing it through
  // `mockInvokeCommands` would test that helper instead of the fallback it is
  // asserting about.
  'src/__tests__/strict-invoke.test.ts',
  // Every bound command in this file now goes through `mockInvokeCommands`.
  // The two stubs left are `read_attachment`, which returns a raw-byte
  // `tauri::ipc::Response`: that cannot carry a `specta::Type`, so the command
  // has no generated binding (`src/lib/ipc-helpers.ts:15-17`) and is not a key
  // of `CommandReturns`. There is nothing for the typed seam to check.
  'src/lib/__tests__/ipc-helpers.test.ts',
]

// Anchored at the alias: only a stub call that immediately follows it counts,
// so a `.mockResolvedValue(` on a different mock nearby cannot be attributed
// to invoke.
const STUB_CALL = /^\s*\.mock(?:Resolved|Rejected)Value(?:Once)?\s*\(/

/** Does this file stub the INVOKE mock specifically with a literal? */
function handStubsInvoke(source: string): boolean {
  if (!source.includes('vi.mocked(invoke)')) return false
  const aliases = new Set<string>(['vi.mocked(invoke)'])
  for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*vi\.mocked\(invoke\)/g)) {
    if (m[1] != null) aliases.add(m[1])
  }
  for (const alias of aliases) {
    let from = source.indexOf(alias)
    while (from !== -1) {
      if (STUB_CALL.test(source.slice(from + alias.length))) return true
      from = source.indexOf(alias, from + 1)
    }
  }
  return false
}

describe('#4668 hand-stubbed invoke ratchet', () => {
  it('the set of files handing invoke a literal only shrinks', () => {
    const live = new Set(
      walkFiles('src', (name) => /\.test\.tsx?$/.test(name)).filter((f) =>
        handStubsInvoke(stripComments(readFileSync(f, 'utf8'))),
      ),
    )
    const baseline = new Set(DELIBERATE_EXCEPTIONS)

    const added = [...live].filter((f) => !baseline.has(f)).toSorted()
    const stale = [...baseline].filter((f) => !live.has(f)).toSorted()

    // One assertion, not two: a migrate-one-add-one PR drifts BOTH ways at
    // once, and a second `expect` would never run to report the half that
    // motivates listing the files at all.
    expect(
      { added, stale },
      '`added` — new file(s) hand `vi.mocked(invoke)` a literal, which nothing checks ' +
        'against the Rust surface. Stub through `mockInvokeCommands` ' +
        '(src/__tests__/helpers/invoke.ts) instead; it is typed against the generated ' +
        'command return types. If the test genuinely needs a shape the backend cannot ' +
        'produce, add it to DELIBERATE_EXCEPTIONS above WITH its reason.\n' +
        '`stale` — DELIBERATE_EXCEPTIONS entr(ies) no longer hand invoke a literal. Delete ' +
        'them; a stale entry lets the set drift back up and hides the migration that ' +
        'earned it.',
    ).toEqual({ added: [], stale: [] })
  })
})
