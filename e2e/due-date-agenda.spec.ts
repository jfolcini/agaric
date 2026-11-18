import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * #5365 — a due date and a task state reach the agenda. `/due` writes
 * `due_date`; today's Due panel and the week view's per-day count read
 * `agenda_cache`, which the real backend rebuilds in the background, so a date
 * that saved but never reached the agenda shows only on the bridge. A checkbox
 * changed in Edit as Markdown sets the task state the panel groups it by.
 *
 * The task lives on a page of its own: the journal's Due panel leaves out the
 * day's own blocks.
 */

const PAGE = 'Due date task page'
const TASK = 'pay the invoice'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The Due panel group header the task is listed under, or null when it is not listed. */
function duePanelGroupOf(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const rows = [
      ...document.querySelectorAll('[data-testid="due-panel"] ul.due-panel-blocks > li'),
    ].toSorted(
      (a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')),
    )
    let group: string | null = null
    for (const row of rows) {
      if (row.classList.contains('due-panel-group-header-row')) group = row.textContent.trim()
      else if (row.id === `block-item-${id}`) return group
    }
    return null
  }, blockId)
}

/** Today's due count in the week view (`journal.agendaCountBadge`). */
async function weekDueCount(page: Page): Promise<number> {
  await page.getByRole('tab', { name: 'Weekly view' }).click()
  const count = page
    .locator(`section[id="journal-${todayStr()}"]`)
    .getByRole('button', { name: /^\d+ Due items?, click to view$/ })
  await expect(count).toBeVisible()
  const n = Number(/^\d+/.exec((await count.getAttribute('aria-label')) ?? '')?.[0])
  await page.getByRole('tab', { name: 'Daily view' }).click()
  return n
}

test('/due today on a TODO lists it in the Due panel and the week count; a checkbox changed in Edit as Markdown regroups it @journal', async ({
  page,
}) => {
  await waitForBoot(page)
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: PAGE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const task = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content: TASK,
    parentId: pageId,
    index: null,
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
    blockId: null,
  })
  await ipc(page, 'set_todo_state', { blockId: task.id, state: 'TODO' })
  await navigateToView(page, 'Journal')
  const before = await weekDueCount(page)

  await openPage(page, PAGE)
  await focusBlockById(page, task.id)
  await typeSlashCommand(page, 'due')
  await page.locator('#suggestion-due').click()
  const picker = page.locator('[data-testid="date-picker-popup"]')
  await picker.getByRole('textbox').fill('today')
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(page.locator(`[data-block-id="${task.id}"] .due-date-chip`)).toBeVisible()
  // Leave the editor: a page reopened with a block still focused mounts its editor
  // a moment after the page, and the focus it takes closes a menu opened meanwhile.
  await page.keyboard.press('Escape')

  await navigateToView(page, 'Journal')
  await expect.poll(() => duePanelGroupOf(page, task.id)).toBe('TODO')
  expect(await weekDueCount(page)).toBe(before + 1)

  // The checkbox, written `- [ ]` in the page's Markdown, becomes `- [/]`.
  await openPage(page, PAGE)
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(editor).toContainText(`- [ ] ${TASK}`)
  await expect(editor).toBeFocused()
  // The whole line, selected as a triple click does, is replaced: a caret placed by
  // a click is taken in a moment later, and keys sent sooner act before it.
  const line = editor.locator('[data-source-line]', { hasText: TASK })
  const text = (await line.textContent()) ?? ''
  await line.click({ clickCount: 3 })
  await page.keyboard.insertText(text.replace('- [ ] ', '- [/] '))
  await expect(editor).toContainText(`- [/] ${TASK}`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()

  await navigateToView(page, 'Journal')
  await expect.poll(() => duePanelGroupOf(page, task.id)).toBe('DOING')
  await openPage(page, PAGE)
  await expect(
    page.locator(`[data-block-id="${task.id}"] [data-testid="task-marker"]`),
  ).toHaveAttribute('aria-label', /^Task: DOING\./)
})
