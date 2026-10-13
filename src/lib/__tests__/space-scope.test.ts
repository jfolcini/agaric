import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { requireActiveScope } from '@/lib/space-scope'

describe('requireActiveScope', () => {
  it('wraps a space id as an active scope', () => {
    expect(requireActiveScope('SPACE_1')).toEqual({ kind: 'active', space_id: 'SPACE_1' })
  })

  // The tripwire under ~10 call sites: an empty id would deserialize into a
  // never-matching filter and silently return nothing. #4412 retired the
  // wrapper whose own suite was the only thing covering this throw.
  it('throws on an empty space id rather than dispatching a never-matching filter', () => {
    expect(() => requireActiveScope('')).toThrow(/empty space id/)
  })
})

// #5415 — a space is always explicit. `toSpaceScope(null)` is gone (a compile
// error now), and this pins the literal: no production call carries a global
// scope. The mock and the generated bindings still spell the variant until the
// backend slice removes it.
describe('no production call site carries a global scope', () => {
  it("finds no `{ kind: 'global' }` outside tests, the mock and the bindings", () => {
    const root = path.resolve(__dirname, '..', '..')
    const offenders: string[] = []
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue
      const full = path.join(entry.parentPath, entry.name)
      const rel = path.relative(root, full)
      if (
        rel.includes('__tests__') ||
        rel.startsWith(path.join('lib', 'tauri-mock')) ||
        rel === path.join('lib', 'bindings.ts')
      ) {
        continue
      }
      const hits = readFileSync(full, 'utf8').match(/kind: 'global'/g)?.length ?? 0
      if (hits > 0) offenders.push(`${rel}:${hits}`)
    }
    expect(offenders).toEqual([])
  })
})
