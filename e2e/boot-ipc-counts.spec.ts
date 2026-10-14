import { expect, test } from './helpers'

/**
 * #5439 — what boot sends before the first journal block. Each assertion is a
 * call boot used to repeat or send for a closed panel. The recorder has to be in
 * place before the mock installs `invoke`, so it wraps the assignment the way
 * `perf.spec.ts` does instead of using `installIpcRecorder`, which only sees
 * calls made after boot.
 */

interface BootCall {
  cmd: string
  args: Record<string, unknown>
}

declare global {
  interface Window {
    __bootIpc__?: BootCall[]
  }
}

function recordIpcFromLoad(): void {
  const calls: BootCall[] = []
  window.__bootIpc__ = calls
  type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
  let internals: Record<string, unknown> | undefined
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    get: () => internals,
    set(value: Record<string, unknown>) {
      internals = value
      let wrapped: Invoke | undefined
      Object.defineProperty(value, 'invoke', {
        configurable: true,
        get: () => wrapped,
        set: (fn: Invoke) => {
          wrapped = (cmd, args, opts) => {
            calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> })
            return fn(cmd, args, opts)
          }
        },
      })
    },
  })
}

test('boot sends each startup query once and skips closed panels (#5439)', async ({ page }) => {
  await page.addInitScript(recordIpcFromLoad)
  await page.goto('/')
  await page.locator('[data-testid="block-static"]').first().waitFor()
  const calls = await page.evaluate(() => window.__bootIpc__ ?? [])
  const named = (cmd: string) => calls.filter((c) => c.cmd === cmd)

  expect(named('list_spaces')).toHaveLength(1)
  expect(named('list_property_keys')).toHaveLength(0)
  expect(named('list_all_pages_in_space')).toHaveLength(1)
  const pageWalks = named('list_blocks').filter(
    (c) => (c.args['request'] as { blockType?: string } | undefined)?.blockType === 'page',
  )
  expect(pageWalks).toHaveLength(0)

  const resolvedIds = named('batch_resolve').flatMap((c) => c.args['ids'] as string[])
  expect(resolvedIds.length).toBe(new Set(resolvedIds).size)
})
