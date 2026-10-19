// SCRATCH (not to be committed): counts PageSourceToolbar / PageSourceBuffer renders and
// keystroke-to-paint time per keystroke in Edit as Markdown, against the production bundle.
import { expect, openPage, test, waitForBoot } from './helpers'

const RUNS = Number(process.env['SCRATCH_RUNS'] ?? 10)
const KEYS = 30
const LINES = Number(process.env['SCRATCH_LINES'] ?? 1000)

test.describe('scratch: source toolbar renders @editor @pages', () => {
  for (let run = 0; run < RUNS; run += 1) {
    test(`run ${run}`, async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.addInitScript(() => {
        const seen = new WeakSet<object>()
        const probe = { toolbar: 0, buffer: 0, commits: 0, paint: [] as number[] }
        Object.assign(window, { __probe: probe })
        const fiberOf = (el: Element | null): any => {
          if (el === null) return null
          const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
          return key === undefined ? null : (el as any)[key]
        }
        const owner = (start: any, has: (p: Record<string, unknown>) => boolean): any => {
          for (let f = start; f; f = f.return) {
            if (typeof f.type === 'function' && f.memoizedProps && has(f.memoizedProps)) return f
          }
          return null
        }
        // A render gives a function component a fresh first-hook object; a bailout reuses it.
        const count = (name: 'toolbar' | 'buffer', f: any): void => {
          if (!f) return
          for (const x of [f, f.alternate]) {
            const hook = x?.memoizedState
            if (hook && typeof hook === 'object' && !seen.has(hook)) {
              seen.add(hook)
              probe[name] += 1
            }
          }
        }
        Object.assign(window, {
          __REACT_DEVTOOLS_GLOBAL_HOOK__: {
            supportsFiber: true,
            isDisabled: false,
            renderers: new Map(),
            inject: () => 1,
            checkDCE: () => {},
            onScheduleFiberRoot: () => {},
            onCommitFiberRoot: () => {
              probe.commits += 1
              const ed = document.querySelector('[data-testid="page-source-editor"]')
              if (ed === null) return
              const bar = ed.parentElement?.parentElement?.querySelector('[role="toolbar"]') ?? null
              count('toolbar', owner(fiberOf(bar), (p) => 'nothingToSave' in p && 'editor' in p))
              count('buffer', owner(fiberOf(bar), (p) => 'pageIds' in p && 'onKeyDown' in p))
            },
            onCommitFiberUnmount: () => {},
            onPostCommitFiberRoot: () => {},
          },
        })
        window.addEventListener(
          'keydown',
          (e) => {
            const t0 = e.timeStamp
            requestAnimationFrame(() => {
              const ch = new MessageChannel()
              ch.port1.onmessage = () => probe.paint.push(performance.now() - t0)
              ch.port2.postMessage(0)
            })
          },
          true,
        )
      })
      await waitForBoot(page)
      await openPage(page, 'Getting Started')
      await page.getByRole('button', { name: 'Page actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await expect(editor).toContainText('Welcome to Agaric!')
      await expect(editor).toBeFocused()
      await expect(page.getByRole('toolbar').first()).toBeVisible()
      if (LINES > 0) {
        const text = Array.from({ length: LINES }, (_, i) => `- filler line ${i} with some words`)
        await page.evaluate((t) => navigator.clipboard.writeText(t.join('\n')), text)
        await page.keyboard.press('ControlOrMeta+End')
        await page.keyboard.press('Enter')
        await page.keyboard.press('ControlOrMeta+V')
        await expect(editor).toContainText(`filler line ${LINES - 1}`)
      }
      // Past the first keystroke, which turns Undo and Save on.
      await page.keyboard.type('ab', { delay: 50 })
      await page.waitForTimeout(500)
      const before = await page.evaluate(() => {
        const p = (window as any).__probe
        p.paint = []
        return { toolbar: p.toolbar, buffer: p.buffer, commits: p.commits }
      })
      for (let i = 0; i < KEYS; i += 1) {
        await page.keyboard.press('x')
        await page.waitForTimeout(60)
      }
      await page.waitForTimeout(500)
      const after = await page.evaluate(() => {
        const p = (window as any).__probe
        return { toolbar: p.toolbar, buffer: p.buffer, commits: p.commits, paint: p.paint }
      })
      const paint = [...after.paint].sort((a: number, b: number) => a - b)
      const median = paint[Math.floor(paint.length / 2)]
      const mean = paint.reduce((a: number, b: number) => a + b, 0) / paint.length
      console.log(
        `SCRATCH ${JSON.stringify({
          run,
          keys: KEYS,
          toolbarRenders: after.toolbar - before.toolbar,
          bufferRenders: after.buffer - before.buffer,
          commits: after.commits - before.commits,
          paintSamples: paint.length,
          medianMs: Number(median.toFixed(2)),
          meanMs: Number(mean.toFixed(2)),
        })}`,
      )
      expect(after.toolbar - before.toolbar).toBe(0)
    })
  }
})
