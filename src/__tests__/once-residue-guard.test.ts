/**
 * Guard for the cross-test `*Once` leak infrastructure itself (#4211).
 *
 * The property under test: a once-value queued by one test and consumed by a
 * DIFFERENT test must fail loudly, naming the line that queued it — while a
 * once-value that is consumed by its own test, drained by `mockReset()`, or
 * simply left behind at the end of a file must NOT fail anything.
 *
 * That second half is the part worth testing. An earlier design failed any
 * test that merely left residue at teardown, which flags already-correct code:
 * `BlockPropertyEditor.test.tsx` leaves residue on purpose to prove its
 * `beforeEach` `mockReset()` drains it. Both halves of the pair are asserted
 * here so the guard cannot silently drift back to over-reporting.
 *
 * Every test drains the recorder via `takeOnceLeaks()` before it ends, because
 * the global `afterEach` in `src/test-setup.ts` throws on anything left in it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  beginOnceResidueTest,
  onceLeakMessage,
  takeOnceLeaks,
} from '@/__tests__/helpers/once-residue'

/**
 * Simulate the test boundary the real guard sees.
 *
 * `beginOnceResidueTest()` is what `src/test-setup.ts` calls in its first
 * `beforeEach`; calling it by hand mid-test makes the tracker believe a new
 * test has started, which is what lets a single `it()` here exercise a
 * genuinely cross-test consumption.
 */
function crossTestBoundary(): void {
  beginOnceResidueTest()
}

/**
 * Queued at MODULE SCOPE — before any test has run, so the tracker records its
 * queuing test as `undefined`. Consumed inside a test far below; the guard must
 * not treat that as a leak.
 */
const moduleScopedDep = vi.fn(() => 'BASE')
moduleScopedDep.mockReturnValueOnce('QUEUED-AT-MODULE-SCOPE')

describe('once-residue guard', () => {
  beforeEach(() => {
    takeOnceLeaks()
  })

  describe('fires on a real cross-test leak', () => {
    it('reports a value queued in one test and consumed in the next', () => {
      const dep = vi.fn(() => 'BASE')
      dep.mockReturnValueOnce('LEAKED')

      crossTestBoundary()

      // `clearAllMocks` is the exact call the 121-file population makes in its
      // `beforeEach`. It must NOT save us here — that is the whole hazard.
      vi.clearAllMocks()
      expect(dep(), 'clearAllMocks must leave the once-queue intact').toBe('LEAKED')

      const found = takeOnceLeaks()
      expect(found).toHaveLength(1)
      expect(found[0]?.site).toMatch(/once-residue-guard\.test\.ts:\d+:\d+$/)
    })

    it('reports a leaked rejection (the #3217 value shape)', async () => {
      const dep = vi.fn(async () => 'BASE')
      dep.mockRejectedValueOnce(new Error('delete failed'))

      crossTestBoundary()

      await expect(dep()).rejects.toThrow('delete failed')
      expect(takeOnceLeaks()).toHaveLength(1)
    })

    it('reports each leaked value separately when several cross the boundary', () => {
      const dep = vi.fn(() => 'BASE')
      dep.mockReturnValueOnce('a').mockReturnValueOnce('b')

      crossTestBoundary()

      expect(dep()).toBe('a')
      expect(dep()).toBe('b')
      expect(takeOnceLeaks()).toHaveLength(2)
    })

    it('covers spyOn mocks, not just vi.fn', () => {
      const obj = { g: () => 'REAL' }
      const spy = vi.spyOn(obj, 'g')
      spy.mockReturnValueOnce('LEAKED')

      crossTestBoundary()

      expect(obj.g()).toBe('LEAKED')
      expect(takeOnceLeaks()).toHaveLength(1)
      spy.mockRestore()
    })
  })

  describe('stays silent on everything that is not a leak', () => {
    it('same-test queue-and-consume is not a leak', () => {
      const dep = vi.fn(() => 'BASE')
      dep.mockReturnValueOnce('USED')
      expect(dep()).toBe('USED')
      expect(takeOnceLeaks()).toEqual([])
    })

    it('residue drained by mockReset() before the next test is not a leak', () => {
      const dep = vi.fn(() => 'BASE')
      dep.mockReturnValueOnce('NEVER-USED')

      // This is `BlockPropertyEditor.test.tsx`'s #4040 fix, and the shape the
      // earlier residue-at-teardown design wrongly failed.
      dep.mockReset()
      dep.mockReturnValue('BASE')

      crossTestBoundary()

      expect(dep()).toBe('BASE')
      expect(takeOnceLeaks()).toEqual([])
    })

    it('residue nobody ever consumes is not a leak', () => {
      const dep = vi.fn(() => 'BASE')
      dep.mockReturnValueOnce('NEVER-USED')

      crossTestBoundary()

      // The file ends here; the value is never handed to anyone.
      expect(takeOnceLeaks()).toEqual([])
    })

    it('a stub queued at MODULE SCOPE is never blamed', () => {
      // `queuedIn === undefined` is the module-scope / `beforeAll` case: such a
      // stub is *meant* to be consumed by a later test, so consuming it here —
      // in a test that plainly did not queue it — must still report nothing.
      // `moduleScopedOnce` is queued at the top of this file, i.e. genuinely
      // before any test ran, which is the condition under test.
      expect(moduleScopedDep()).toBe('QUEUED-AT-MODULE-SCOPE')
      expect(takeOnceLeaks()).toEqual([])
    })
  })

  describe('is non-perturbing', () => {
    it('preserves return value, this-binding, async resolution and rejection', async () => {
      const resolved = vi.fn(async () => 'BASE')
      resolved.mockResolvedValueOnce('ONCE')
      await expect(resolved()).resolves.toBe('ONCE')
      await expect(resolved()).resolves.toBe('BASE')

      const ctx = { tag: 'CTX', fn: vi.fn() }
      ctx.fn.mockImplementationOnce(function (this: { tag: string }) {
        return this.tag
      })
      expect(ctx.fn()).toBe('CTX')

      const args = vi.fn()
      args.mockImplementationOnce((...a: unknown[]) => a.join('-'))
      expect(args(1, 2, 3)).toBe('1-2-3')

      expect(takeOnceLeaks()).toEqual([])
    })

    it('keeps `*Once` chainable and preserves call recording', () => {
      const dep = vi.fn((_arg: string) => 'BASE')
      expect(dep.mockReturnValueOnce('a')).toBe(dep)
      dep('arg')
      expect(dep).toHaveBeenCalledWith('arg')
      expect(dep.mock.calls).toHaveLength(1)
      takeOnceLeaks()
    })
  })

  describe('message', () => {
    it('names the queuing site, both tests, and the fix', () => {
      const msg = onceLeakMessage([
        {
          site: 'src/components/__tests__/Thing.test.tsx:412:7',
          queuedIn: 'Thing > queues a deferred',
          consumedIn: 'Thing > an innocent later test',
          mockName: 'mockedInvoke',
        },
      ])
      expect(msg).toContain('src/components/__tests__/Thing.test.tsx:412:7')
      expect(msg).toContain('Thing > queues a deferred')
      expect(msg).toContain('Thing > an innocent later test')
      expect(msg).toContain('mockedInvoke')
      expect(msg).toContain('mockInvokeCommands')
      expect(msg).toContain('#4211')
      expect(msg).toContain('this test is the victim, not the cause')
    })
  })
})
