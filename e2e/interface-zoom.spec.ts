/**
 * #5646 — the interface zoom. The browser mock has no webview to zoom, so the
 * spec records the zoom the app sends to it (`set_webview_zoom`) and reads the
 * level back from Settings › Appearance and across a reload.
 *
 * Webview zoom is page zoom: a window W px wide lays out at W / zoom CSS px. So
 * the range's cap is checked by laying the app out at the default window
 * (`tauri.conf.json`) divided by the largest level the Zoom control offers.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import {
  expect,
  expectNoHorizontalOverflow,
  expectViewLoaded,
  navigateToView,
  openSettingsTab,
  test,
  type TopLevelView,
  waitForBoot,
} from './helpers'

declare global {
  interface Window {
    __zoomCalls__?: number[]
  }
}

/** Record every `set_webview_zoom` from page load, before the mock installs `invoke`. */
function recordZoomFromLoad(): void {
  const calls: number[] = []
  window.__zoomCalls__ = calls
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
            if (cmd === 'plugin:webview|set_webview_zoom') {
              calls.push((args as { value: number }).value)
            }
            return fn(cmd, args, opts)
          }
        },
      })
    },
  })
}

function zoomCalls(page: Page): Promise<number[]> {
  return page.evaluate(() => window.__zoomCalls__ ?? [])
}

async function openAppearance(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Appearance')
}

function zoomSelect(page: Page) {
  return page.getByRole('combobox', { name: 'Zoom', exact: true })
}

test('the zoom shortcuts and the Appearance control set one saved level @settings', async ({
  page,
}) => {
  await page.addInitScript(recordZoomFromLoad)
  await waitForBoot(page)
  // 100% is where the webview starts, so boot sends nothing.
  expect(await zoomCalls(page)).toEqual([])

  await page.keyboard.press('Control+=')
  await page.keyboard.press('Control+=')
  await page.keyboard.press('Control+-')
  await expect.poll(() => zoomCalls(page)).toEqual([1.1, 1.25, 1.1])

  await openAppearance(page)
  await expect(zoomSelect(page)).toHaveText('110%')
  await zoomSelect(page).click()
  await page.getByRole('option', { name: '150%', exact: true }).click()
  await expect.poll(() => zoomCalls(page)).toEqual([1.1, 1.25, 1.1, 1.5])

  // A restart: boot applies the saved level before anything is pressed.
  await page.reload()
  await expect.poll(() => zoomCalls(page)).toEqual([1.5])
  await openAppearance(page)
  await expect(zoomSelect(page)).toHaveText('150%')

  await page.keyboard.press('Control+0')
  await expect.poll(() => zoomCalls(page)).toEqual([1.5, 1])
  await expect(zoomSelect(page)).toHaveText('100%')
})

/** Every top-level view, as `mobile-overflow.spec.ts` sweeps them. */
const VIEWS: readonly TopLevelView[] = [
  'Journal',
  'Pages',
  'Search',
  'Tags',
  'Settings',
  'Graph',
  'Templates',
  'Advanced Query',
  'Status',
  'History',
  'Trash',
]

test('at the largest zoom the default window scrolls no view sideways @settings', async ({
  page,
}) => {
  const conf = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
  ) as { app: { windows: Array<{ width: number; height: number }> } }
  const win = conf.app.windows[0]
  if (!win) throw new Error('tauri.conf.json declares no window')

  await waitForBoot(page)
  await openAppearance(page)
  await zoomSelect(page).click()
  await expect(page.getByRole('option', { name: '100%', exact: true })).toBeVisible()
  const levels = await page.getByRole('option').allTextContents()
  await page.keyboard.press('Escape')
  const max = Math.max(...levels.map((l) => Number.parseFloat(l) / 100))
  expect(max, `zoom levels ${levels.join(', ')}`).toBeGreaterThan(1)

  await page.setViewportSize({
    width: Math.floor(win.width / max),
    height: Math.floor(win.height / max),
  })
  // The narrow layout has taken over before the first view is opened.
  await expect(page.getByTestId('mobile-sidebar-trigger')).toBeVisible()
  for (const view of VIEWS) {
    await navigateToView(page, view)
    await expectViewLoaded(page, view)
    await expectNoHorizontalOverflow(page, undefined, `${view} view at ${max * 100}% zoom`)
  }
})
