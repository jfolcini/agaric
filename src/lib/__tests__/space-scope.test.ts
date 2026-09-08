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
