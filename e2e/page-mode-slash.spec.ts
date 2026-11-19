/**
 * The slash commands page mode offers leave the backend as block mode's do
 * (#5743), against the mock backend: each command runs on the same block of
 * two twin pages, one in each mode, and the stored rows are compared with each
 * other and with what the command is meant to write. `/todo`, `/h2`, a date and
 * the property drawer are in `page-mode.spec.ts`. `/table` is page mode's alone
 * here: block mode puts the table in a block of its own.
 */

import type { Page } from '@playwright/test'

import {
  activeSuggestionPopup,
  expect,
  focusBlockById,
  ipc,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'
import {
  PAGE_EDITOR,
  type SeededPage,
  backendBlocks,
  caret,
  modeSwitch,
  openPageByTitle,
  seedPage,
} from './page-mode'

type StoredRow = [content: string, todo: string | null, priority: string | null, props: string[]]

/** The page's blocks as stored: text, task state, priority and `key=value` properties. */
async function storedRows(page: Page, pageId: string): Promise<StoredRow[]> {
  const rows: StoredRow[] = []
  for (const { id } of await backendBlocks(page, pageId)) {
    const row = await ipc<{ content: string; todo_state: string | null; priority: string | null }>(
      page,
      'get_block',
      { blockId: id },
    )
    const props = await ipc<Array<{ key: string; value_text: string | null }>>(
      page,
      'get_properties',
      { blockId: id },
    )
    rows.push([
      row.content,
      row.todo_state,
      row.priority,
      // Not the timestamps a task state brings: they differ run to run.
      props
        .filter((p) => !p.key.endsWith('_at'))
        .map((p) => `${p.key}=${p.value_text ?? ''}`)
        .toSorted(),
    ])
  }
  return rows
}

interface Command {
  /** What is typed after the `/`. */
  query: string
  /** The command picked from the menu, `#suggestion-<id>`. */
  id: string
  /** What follows the pick: text typed, or an option of the picker it opens clicked. */
  after?: (page: Page) => Promise<void>
  /** The rows both pages hold afterwards. */
  stored: StoredRow[]
}

const NEXT: StoredRow = ['next', null, null, []]

const pick = (picker: string, option: string) => (page: Page) =>
  page
    .getByRole('listbox', { name: picker })
    .getByRole('option', { name: option, exact: true })
    .click()

const COMMANDS: Command[] = [
  { query: 'quote', id: 'quote', stored: [['> buy milk ', null, null, []], NEXT] },
  { query: 'code', id: 'code', stored: [['```\nbuy milk \n```', null, null, []], NEXT] },
  {
    query: 'callout',
    id: 'callout-warning',
    stored: [['> [!WARNING] buy milk ', null, null, []], NEXT],
  },
  { query: 'h3', id: 'h3', stored: [['### buy milk ', null, null, []], NEXT] },
  {
    query: 'numbered',
    id: 'numbered-list',
    stored: [['buy milk ', null, null, ['listStyle=ordered']], NEXT],
  },
  {
    query: 'bullet',
    id: 'bullet-list',
    stored: [['buy milk ', null, null, ['listStyle=bullet']], NEXT],
  },
  { query: 'priority', id: 'priority-high', stored: [['buy milk ', null, '1', []], NEXT] },
  { query: 'doing', id: 'doing', stored: [['buy milk ', 'DOING', null, []], NEXT] },
  { query: 'effort', id: 'effort-1h', stored: [['buy milk ', null, null, ['effort=1h']], NEXT] },
  {
    query: 'bold',
    id: 'bold',
    after: (page) => page.keyboard.type('now'),
    stored: [['buy milk **now**', null, null, []], NEXT],
  },
  {
    query: 'link',
    id: 'link',
    after: pick('Page links', 'Projects'),
    stored: [['buy milk [[00000000000000000000PAGE04]]', null, null, []], NEXT],
  },
  {
    query: 'tag',
    id: 'tag',
    after: pick('Tags', 'idea'),
    stored: [['buy milk #[000000000000000000000TAG03]', null, null, []], NEXT],
  },
]

/** In the block being edited, either mode's: open the menu on the command, pick it, and follow up. */
async function runCommand(page: Page, command: Command): Promise<void> {
  await typeSlashCommand(page, command.query)
  const item = activeSuggestionPopup(page).locator(`[id="suggestion-${command.id}"]`)
  await item.click()
  await expect(item).toHaveCount(0)
  await command.after?.(page)
}

test.describe('page mode’s slash commands write what block mode’s do (#5743) @editor @pages', () => {
  let inBlocks: SeededPage
  let inPage: SeededPage

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    inBlocks = await seedPage(page, 'Slash in blocks', [
      [0, 'buy milk'],
      [0, 'next'],
    ])
    inPage = await seedPage(page, 'Slash in page', [
      [0, 'buy milk'],
      [0, 'next'],
    ])
  })

  // The command's write and a write the editor started before it can reach the backend in either
  // order. A leave in block mode while `/callout-warning` was writing still saw the text from before
  // it, and when that write landed last the callout was gone.
  test('a leave while block mode’s /callout-warning is writing keeps the callout', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & {
        __TAURI_INTERNALS__: { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> }
      }
      const internals = w.__TAURI_INTERNALS__
      const invoke = internals.invoke.bind(internals)
      let left: () => void = () => undefined
      const hasLeft = new Promise<void>((resolve) => {
        left = resolve
      })
      let commandAnswered: () => void = () => undefined
      const command = new Promise<void>((resolve) => {
        commandAnswered = resolve
      })
      let inFlight = 0
      w['__left'] = left
      w['__editsSettled'] = () => inFlight === 0
      internals.invoke = async (cmd, ...rest) => {
        if (cmd !== 'edit_block') return invoke(cmd, ...rest)
        const toText = (rest[0] as { toText: string }).toText
        if (toText.startsWith('> [!')) {
          inFlight++
          try {
            return await invoke(cmd, ...rest)
          } finally {
            inFlight--
            commandAnswered()
          }
        }
        // Started while another write is on its way: it lands after the command's.
        if (inFlight > 0) await command
        inFlight++
        try {
          // Only once the block is left: a leave then overlaps the writes before the command's.
          await hasLeft
          return await invoke(cmd, ...rest)
        } finally {
          inFlight--
        }
      }
    })
    const command = COMMANDS.find((c) => c.id === 'callout-warning') as Command
    await openPageByTitle(page, 'Slash in blocks')
    await focusBlockById(page, inBlocks.ids[0] as string)
    await runCommand(page, command)
    await page.keyboard.press('Escape')
    await page.evaluate(() => (window as unknown as { __left: () => void }).__left())
    await page.waitForFunction(() =>
      (window as unknown as { __editsSettled: () => boolean }).__editsSettled(),
    )

    expect(await storedRows(page, inBlocks.pageId)).toEqual(command.stored)
  })

  for (const command of COMMANDS) {
    test(`/${command.id} leaves the same rows in both modes`, async ({ page }) => {
      await openPageByTitle(page, 'Slash in blocks')
      await focusBlockById(page, inBlocks.ids[0] as string)
      await runCommand(page, command)
      await page.keyboard.press('Escape')

      await openPageByTitle(page, 'Slash in page')
      await modeSwitch(page, 'Page').click()
      await expect(page.locator(`${PAGE_EDITOR} [data-page-block]`)).toHaveCount(2)
      await caret(page, 0, 'end')
      await runCommand(page, command)
      await page.keyboard.press('Escape')

      await expect.poll(() => storedRows(page, inPage.pageId)).toEqual(command.stored)
      expect(await storedRows(page, inBlocks.pageId)).toEqual(command.stored)
    })
  }

  test('/table’s grid puts the table in the caret’s block, which keeps it', async ({ page }) => {
    await openPageByTitle(page, 'Slash in page')
    await modeSwitch(page, 'Page').click()
    await expect(page.locator(`${PAGE_EDITOR} [data-page-block]`)).toHaveCount(2)
    await caret(page, 0, 'end')

    // Picked from the keyboard: a pointer left over the grid sets its size.
    const list = await typeSlashCommand(page, 'table')
    await expect(list.locator('#suggestion-table')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('grid', { name: 'Insert table' })).toBeFocused()
    await expect(page.getByTestId('table-picker-label')).toHaveText('3 × 3')
    await page.keyboard.press('Enter')

    const table = page.locator(`[data-page-block-id="${inPage.ids[0]}"] table`)
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(page.locator(PAGE_EDITOR)).toBeFocused()
    await page.keyboard.type('cell')
    await page.keyboard.press('Escape')
    const stored: StoredRow[] = [
      ['buy milk \n| cell |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', null, null, []],
      NEXT,
    ]
    await expect.poll(() => storedRows(page, inPage.pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openPageByTitle(page, 'Slash in page')
    await modeSwitch(page, 'Page').click()
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(table.locator('th').first()).toHaveText('cell')
    expect(await storedRows(page, inPage.pageId)).toEqual(stored)
  })
})
