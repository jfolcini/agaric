import { describe, expect, it } from 'vitest'

// @ts-expect-error — no type declarations for the .mjs script.
import { groupModules } from '../../scripts/run-mutation.mjs'
// @ts-expect-error — no type declarations for the .mjs module.
import { MODULE_NAMES } from '../../stryker.modules.mjs'

// #5915 — the weekly lane runs one group per matrix leg and the merge job's
// liveness check needs every module from exactly one of them.
describe('groupModules', () => {
  it('deals the names round-robin', () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    expect(groupModules('1/2', names)).toEqual(['a', 'c', 'e'])
    expect(groupModules('2/2', names)).toEqual(['b', 'd'])
    expect(groupModules('1/1', names)).toEqual(names)
  })

  it('puts every enrolled module in exactly one of four groups', () => {
    const groups = ['1/4', '2/4', '3/4', '4/4'].map((spec) => groupModules(spec))
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect(groups.flat().toSorted(byName)).toEqual([...MODULE_NAMES].toSorted(byName))
  })

  it.each(['0/4', '5/4', '1/0', '1', '1/4x', undefined])('rejects the spec %s', (spec) => {
    expect(() => groupModules(spec, ['a'])).toThrow('--group needs k/n with 1 <= k <= n')
  })
})
