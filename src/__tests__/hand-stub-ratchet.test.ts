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
 * Equality, not `<=` — a stale baseline would hide a migration and let the
 * count drift back up. Same mechanism as `tauri-import-baseline`.
 *
 * The match is textual, so the source goes through `js-scanner.mjs`'s
 * `stripComments` first (the sanctioned tokenizer) and the walk is fenced to
 * `*.test.ts(x)`: strings survive `stripComments` by design, and
 * `helpers/invoke.ts` names the expression in an error message.
 *
 * Zero is not the target. A test needing an ARBITRARY response — error
 * injection, a malformed payload, an IPC rejection — is testing the frontend's
 * handling of a shape the backend should never send, and a typed seam would
 * destroy it. Hence a ratchet, not a ban.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped JS helper, the repo's sanctioned tokenizer (#3991)
import { stripComments } from '../../scripts/lib/js-scanner.mjs'

/**
 * Files still handing the invoke mock a hand-written literal.
 *
 * Lower this when you migrate one to `mockInvokeCommands`; the test fails if it
 * does not match, in either direction.
 */
const HAND_STUB_FILE_BASELINE = 85

// Anchored at the alias: only a stub call that immediately follows it counts,
// so a `.mockResolvedValue(` on a different mock nearby cannot be attributed
// to invoke.
const STUB_CALL = /^\s*\.mock(?:Resolved|Rejected)Value(?:Once)?\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out)
    } else if (/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

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
  it('the number of files handing invoke a literal only goes down', () => {
    const files = walk('src').filter((f) => handStubsInvoke(stripComments(readFileSync(f, 'utf8'))))

    expect(files.length, `hand-stubbing files:\n${files.join('\n')}`).toBe(HAND_STUB_FILE_BASELINE)
  })
})
