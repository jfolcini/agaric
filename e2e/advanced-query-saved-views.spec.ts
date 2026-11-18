/**
 * Advanced query saved views (#5738): a saved query is listed after leaving
 * the view and coming back, Load restores its tree and results, rename and
 * delete stick, and another space does not list it. A view is a page carrying
 * the `saved_view` property (#6544), left out of the Pages list and the `[[`
 * picker, and a deleted one waits in the Trash. Each is one surface's state
 * over IPC calls the mock models, so the mock lane shows it failing.
 *
 * Seed ids pointer: `SEED_IDS` in `src/lib/tauri-mock/seed.ts`; the opt-in
 * second space "Work" is `seedWorkSpace` there.
 */
import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  activeSuggestionList,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  switchToSpace,
  test,
  waitForBoot,
} from './helpers'

const VIEW = 'Work blocks'
const RENAMED = 'Work items'

// Diagnostic for the rename dialog that did not open on #6910's run 44306809918:
// on a failure the report carries who got each pointer event and when a dialog
// mounted. Delete it once that flake is root-caused.
const TRACE = '__savedViewsTrace'

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    const trace: string[] = []
    ;(window as unknown as Record<string, string[]>)[key] = trace
    const ids = new WeakMap<Node, number>()
    let next = 1
    const name = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return target === null ? 'null' : target.constructor.name
      if (!ids.has(target)) ids.set(target, next++)
      const label = target.getAttribute('aria-label') ?? target.textContent?.slice(0, 24) ?? ''
      return `${target.tagName.toLowerCase()}#${ids.get(target)}[${label}]`
    }
    const note = (what: string): void => {
      trace.push(`${performance.now().toFixed(0)} ${what}`)
    }
    for (const type of ['pointerdown', 'pointerup', 'click', 'focusin']) {
      document.addEventListener(type, (e) => note(`${type} ${name(e.target)}`), true)
    }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const [nodes, sign] of [
          [record.addedNodes, '+'],
          [record.removedNodes, '-'],
        ] as const) {
          for (const node of nodes) {
            if (
              node instanceof Element &&
              (node.parentElement?.closest('[role="dialog"]') ?? null) === null &&
              (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]') !== null)
            ) {
              note(`dialog${sign} ${name(node)}`)
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true })
  }, TRACE)
  await waitForBoot(page)
})

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return
  const trace = await page
    .evaluate((key) => (window as unknown as Record<string, string[]>)[key] ?? [], TRACE)
    .catch((e: unknown) => [`trace unreadable: ${String(e)}`])
  await testInfo.attach('saved-views-trace', { body: trace.join('\n'), contentType: 'text/plain' })
})

function resultRows(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Query results' }).getByRole('option')
}

function savedViews(page: Page): Locator {
  return page.getByRole('region', { name: 'Saved views', exact: true })
}

function tagLeaf(page: Page): Locator {
  return page
    .getByRole('group', { name: 'Filter', exact: true })
    .getByRole('group', { name: 'tag: work', exact: true })
}

/** Leave Advanced query for the journal and open it again. */
async function reopenAdvancedQuery(page: Page): Promise<void> {
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Advanced query')
}

/** The tag `work` leaf keeps exactly the three seeded blocks tagged `work`. */
const WORK_ROWS = [/Weekly standup notes/, /Fix login bug/, /Ship v2\.0 release/]

test('a saved view is listed after leaving, loads, renames, deletes to the Trash, and stays in its space @search @spaces @pages', async ({
  page,
}) => {
  await navigateToView(page, 'Advanced query')
  const root = page.getByRole('group', { name: 'Filter', exact: true })
  await root.getByRole('button', { name: 'Add filter', exact: true }).click()
  const pop = activePopover(page)
  await pop.getByRole('button', { name: /^Tag/ }).click()
  await pop.getByRole('button', { name: 'work', exact: true }).click()
  await expect(tagLeaf(page)).toBeVisible()
  await expect(resultRows(page)).toHaveText(WORK_ROWS)

  await page.getByRole('button', { name: 'Save the current query as a named view' }).click()
  const saveDialog = page.getByRole('dialog')
  await saveDialog.getByRole('textbox').fill(VIEW)
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()

  // Clear the builder so only Load can bring the leaf back.
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(tagLeaf(page)).toHaveCount(0)

  await reopenAdvancedQuery(page)
  await expect(savedViews(page).getByTestId('saved-view-row')).toHaveText([new RegExp(VIEW)])
  await expect(tagLeaf(page)).toHaveCount(0)

  // The view's page is in no page list: not in the Pages view, not offered by `[[`.
  await navigateToView(page, 'Pages')
  await expect(page.getByRole('grid').getByText('Quick Notes', { exact: true })).toBeVisible()
  await expect(page.getByRole('grid').getByText(VIEW, { exact: true })).toHaveCount(0)
  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('End')
  await page.keyboard.type(' [[Work bl', { delay: 30 })
  await expect(activeSuggestionList(page).getByTestId('suggestion-item')).toHaveText([
    /^Create\s*Work bl$/,
  ])
  await page.keyboard.press('Escape')
  await navigateToView(page, 'Advanced query')
  await savedViews(page)
    .getByRole('button', { name: `Load "${VIEW}"` })
    .click()
  await expect(tagLeaf(page)).toBeVisible()
  await expect(resultRows(page)).toHaveText(WORK_ROWS)

  await page.evaluate((key) => {
    ;(window as unknown as Record<string, string[]>)[key]?.push('--- rename click')
  }, TRACE)
  await savedViews(page)
    .getByRole('button', { name: `Rename "${VIEW}"` })
    .click()
  const renameDialog = page.getByRole('dialog')
  await renameDialog.getByRole('textbox').fill(RENAMED)
  await renameDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await reopenAdvancedQuery(page)
  await expect(savedViews(page).getByTestId('saved-view-row')).toHaveText([new RegExp(RENAMED)])

  await switchToSpace(page, 'Work')
  await navigateToView(page, 'Advanced query')
  await expect(savedViews(page).getByText('No saved views yet')).toBeVisible()
  await switchToSpace(page, 'Personal')
  await navigateToView(page, 'Advanced query')
  await expect(savedViews(page).getByTestId('saved-view-row')).toHaveText([new RegExp(RENAMED)])

  await savedViews(page)
    .getByRole('button', { name: `Delete "${RENAMED}"` })
    .click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await reopenAdvancedQuery(page)
  await expect(savedViews(page).getByText('No saved views yet')).toBeVisible()

  await navigateToView(page, 'Trash')
  await expect(page.getByTestId('trash-item').filter({ hasText: RENAMED })).toHaveCount(1)
})
