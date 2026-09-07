/**
 * #4668 — the hand-stubbed `invoke` ratchet.
 *
 * ## What this counts, and why THIS and not the obvious thing
 *
 * The obvious metric — files containing `vi.mocked(invoke)` — cannot ratchet.
 * `mockInvokeCommands` returns an implementation you still have to install, so
 * a fully migrated file *keeps* that string; 25 of the files matching it today
 * already use the typed seam. Migrating a directory would not move the number
 * at all, and the only way to lower it would be to delete a test file. A count
 * that only falls when tests are deleted is worse than no count.
 *
 * So this counts what actually changes on migration: files that hand the INVOKE
 * mock a literal, via `.mockResolvedValue(…)` / `.mockRejectedValue(…)` (and the
 * `Once` variants) on `vi.mocked(invoke)` or on a local alias bound to it. That
 * literal is the thing nothing checks against the Rust surface — a component can
 * be green for years against a response the backend never produces. Route the
 * file's last literal through `mockInvokeCommands` and it drops out of the
 * count, because that seam is typed against the generated command return types
 * and fails `npm run typecheck` on drift.
 *
 * ## Why an equality rather than a ceiling
 *
 * `<=` lets a stale baseline hide a win: migrate a file, the count drops, the
 * test still passes, and the number is free to drift back up unnoticed.
 * Equality fails in both directions. Same mechanism as `tauri-import-baseline`
 * and the #4667 conformance ratchet.
 *
 * ## What is NOT debt
 *
 * A test that needs an *arbitrary* response — error injection, a malformed
 * payload, an IPC rejection path — is testing the frontend's handling of a shape
 * the backend should never send. Forcing those through a typed seam would
 * destroy the test. #4668 expects them to end as a deliberate documented
 * minority, not zero, which is why this is a ratchet and not a ban.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Files still handing the invoke mock a hand-written literal.
 *
 * Lower this when you migrate one to `mockInvokeCommands`; the test fails if it
 * does not match, in either direction.
 */
const HAND_STUB_FILE_BASELINE = 87

const STUB_CALL = /\.mock(?:Resolved|Rejected)Value(?:Once)?\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out)
    } else if (/\.tsx?$/.test(entry)) {
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
      if (STUB_CALL.test(source.slice(from + alias.length, from + alias.length + 80))) return true
      from = source.indexOf(alias, from + 1)
    }
  }
  return false
}

describe('#4668 hand-stubbed invoke ratchet', () => {
  it('the number of files handing invoke a literal only goes down', () => {
    // This file names the patterns in its own prose, so it would otherwise
    // count itself — the same self-match that makes a `pgrep -f` waiter never
    // exit.
    const files = walk('src')
      .filter((f) => !f.endsWith('hand-stub-ratchet.test.ts'))
      .filter((f) => handStubsInvoke(readFileSync(f, 'utf8')))

    expect(files.length, `hand-stubbing files:\n${files.join('\n')}`).toBe(HAND_STUB_FILE_BASELINE)
  })
})
