/**
 * A test that announces two distinct messages and ends leaves the announcer's
 * real `FLUSH_GAP_MS` timer pending. If it fires after the file's environment
 * is torn down, `getOrCreate()` throws `document is not defined` as an
 * unhandled error that fails the run with zero failed tests. The shared
 * `afterEach` in `src/test-setup.ts` drains the queue so that timer is a no-op.
 *
 * The `afterAll` below stands in for the environment teardown: it runs after
 * every `afterEach`, removes `document`, and waits out the timer.
 */

import { afterAll, expect, it } from 'vitest'

import { announce } from '@/lib/announcer'

afterAll(async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  expect(descriptor).toBeDefined()
  Reflect.deleteProperty(globalThis, 'document')
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
  } finally {
    Object.defineProperty(globalThis, 'document', descriptor as PropertyDescriptor)
  }
})

it('leaves no queued announcement to flush after the test ends', async () => {
  announce('first')
  announce('second')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(document.getElementById('sr-announcer')?.textContent).toBe('first')
})
