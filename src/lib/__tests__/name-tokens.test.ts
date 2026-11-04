import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { nameKey } from '@/lib/name-tokens'

interface NameKeyCase {
  name: string
  input: string
  key: string
}

const { nameKeyCases } = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../conformance/reference-tokens.vectors.json'),
    'utf8',
  ),
) as { nameKeyCases: NameKeyCase[] }

// #6278 — the rows `name_key_matches_the_shared_vectors` reads in Rust.
describe('nameKey folds a name as the backend does', () => {
  it('reads the shared vectors', () => {
    expect(nameKeyCases.length).toBeGreaterThan(0)
  })

  it.each(nameKeyCases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(nameKey(row.input)).toBe(row.key)
  })
})
