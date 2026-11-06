import type { Page } from '@playwright/test'

import {
  activeDialog,
  activeSuggestionList,
  expect,
  focusBlockById,
  ipc,
  openPage,
  reopenPage,
  showJournalPages,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * `/meeting` (#5364): the dialog makes the meeting page from a template, with
 * `#meeting` and the `meeting_date` built-in, puts the files on its recording
 * block and links the page from the block the command ran in. Checked by
 * following the link, then again after leaving the page and coming back.
 */

/** BLOCK_GS_1, the first child of "Getting Started" in the mock seed. */
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

async function today(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
}

async function openMeetingDialog(page: Page) {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await focusBlockById(page, BLOCK_GS_1)
  await typeSlashCommand(page, 'meeting')
  await activeSuggestionList(page)
    .locator('[data-testid="suggestion-item"]', { hasText: 'MEETING' })
    .click()
  const dialog = activeDialog(page)
  await expect(dialog.getByRole('heading', { name: 'New meeting' })).toBeVisible()
  return dialog
}

/** What the meeting page holds, read back from the backend. */
async function meetingPage(page: Page, title: string) {
  const pages = await ipc<{ items: Array<{ id: string; content: string }> }>(page, 'list_blocks', {
    blockType: 'page',
    parentId: null,
    tagId: null,
    showDeleted: null,
    agendaDate: null,
    agendaDateRange: null,
    agendaSource: null,
    cursor: null,
    limit: 100,
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  })
  const row = pages.items.find((p) => p.content === title)
  if (row === undefined) return null
  const props = await ipc<Array<{ key: string; value_date: string | null }>>(
    page,
    'get_properties',
    { blockId: row.id },
  )
  return { id: row.id, meetingDate: props.find((p) => p.key === 'meeting_date')?.value_date }
}

test.describe('/meeting makes a meeting page linked from the block @attachments @pages', () => {
  test('from a template, with its files, reached through the link and again after leaving', async ({
    page,
  }) => {
    const day = await today(page)
    const title = `Sync ${day}`
    const dialog = await openMeetingDialog(page)

    await dialog.getByLabel('Title').fill('Sync')
    await expect(dialog.getByLabel('Date')).toHaveValue(day)
    await dialog.getByRole('combobox', { name: 'Template' }).click()
    await page.getByRole('option', { name: 'Meeting Notes Template', exact: true }).click()
    await dialog.getByLabel('Audio').setInputFiles({
      name: 'call.ogg',
      mimeType: 'audio/ogg',
      buffer: Buffer.from('OggS'),
    })
    await dialog.getByLabel('Transcript').setInputFiles({
      name: 'call.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('[00:00:04] **Alice:** Hi.'),
    })
    await dialog.getByLabel('Summary text').fill('Shipped it.')
    await dialog.getByRole('button', { name: 'Create meeting' }).click()
    await expect(dialog).toBeHidden()

    const meeting = await meetingPage(page, title)
    expect(meeting?.meetingDate).toBe(day)

    const link = page.locator(`[data-block-id="${BLOCK_GS_1}"]`).getByText(title, { exact: true })
    await expect(link).toBeVisible()
    await link.click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
    await expect(page.getByText(`Action items for ${title}`)).toBeVisible()
    await expect(page.getByText('Shipped it.')).toBeVisible()
    await expect(page.getByText('call.ogg')).toBeVisible()
    await page.getByRole('button', { name: /^Properties/ }).click()
    const meetingDate = page
      .locator('.page-property-table')
      .getByText('Meeting Date', { exact: true })
    await expect(meetingDate).toBeVisible()
    await expect(page.getByLabel('meeting_date value')).toHaveValue(day)
    await expect(page.getByRole('button', { name: 'Remove tag meeting' })).toBeVisible()

    await reopenPage(page, title)
    await expect(page.getByText(`Action items for ${title}`)).toBeVisible()
    await expect(page.getByText('call.ogg')).toBeVisible()
    await expect(page.getByText('Shipped it.')).toBeVisible()
  })
})

test.describe('New meeting from the palette links the meeting from today’s journal @attachments @pages @search', () => {
  test('the open journal shows the link, and the dialog remembers the template', async ({
    page,
  }) => {
    await waitForBoot(page)
    const day = await today(page)
    const title = `Retro ${day}`

    await page.getByTestId('header-search-button').click()
    await page.getByTestId('command-palette-input').fill('>New meeting')
    await page.getByRole('option', { name: 'New meeting' }).click()
    const dialog = activeDialog(page)
    await expect(dialog.getByRole('heading', { name: 'New meeting' })).toBeVisible()
    await expect(dialog.getByLabel('Date')).toHaveValue(day)
    await dialog.getByLabel('Title').fill('Retro')
    await dialog.getByRole('combobox', { name: 'Template' }).click()
    await page.getByRole('option', { name: 'Meeting Notes Template', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create meeting' }).click()
    await expect(dialog).toBeHidden()

    const meeting = await meetingPage(page, title)
    expect(meeting?.meetingDate).toBe(day)
    const link = page.locator('[data-block-id]').getByText(title, { exact: true })
    await expect(link).toBeVisible()
    await link.click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
    await expect(page.getByText(`Action items for ${title}`)).toBeVisible()

    await reopenPage(page, title)
    await expect(page.getByText(`Action items for ${title}`)).toBeVisible()

    await page.getByTestId('header-search-button').click()
    await page.getByTestId('command-palette-input').fill('>New meeting')
    await page.getByRole('option', { name: 'New meeting' }).click()
    await expect(activeDialog(page).getByRole('combobox', { name: 'Template' })).toHaveText(
      'Meeting Notes Template',
    )
  })
})

test.describe('/meeting on a journal day dates the meeting that day and lays out its recording @attachments @pages', () => {
  test('the day’s date, then the audio, the summary open and the transcript closed, after leaving too', async ({
    page,
  }) => {
    await waitForBoot(page)
    const day = '2031-03-14'
    const dayId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: day,
      spaceId: 'SPACE_PERSONAL',
    })
    const { id: blockId } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: 'Standup notes',
      parentId: dayId,
      scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
    })
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await showJournalPages(page)
    await page.getByText(day, { exact: true }).click()
    await focusBlockById(page, blockId)
    await typeSlashCommand(page, 'meeting')
    await activeSuggestionList(page)
      .locator('[data-testid="suggestion-item"]', { hasText: 'MEETING' })
      .click()
    const dialog = activeDialog(page)
    await expect(dialog.getByLabel('Date')).toHaveValue(day)
    await dialog.getByLabel('Title').fill('Standup')
    await dialog.getByLabel('Audio').setInputFiles({
      name: 'call.ogg',
      mimeType: 'audio/ogg',
      buffer: Buffer.from('OggS'),
    })
    await dialog.getByLabel('Transcript').setInputFiles({
      name: 'call.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('[00:00] **Alice:** Hi.\n\n[00:04] **Bob:** Bye.'),
    })
    await dialog.getByRole('radio', { name: 'Attach a file' }).click()
    await dialog.getByLabel('Summary file').setInputFiles({
      name: 'recap.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Shipped it.'),
    })
    await dialog.getByRole('button', { name: 'Create meeting' }).click()
    await expect(dialog).toBeHidden()

    const title = `Standup ${day}`
    expect((await meetingPage(page, title))?.meetingDate).toBe(day)
    const link = page.locator(`[data-block-id="${blockId}"]`).getByText(title, { exact: true })
    await expect(link).toBeVisible()
    await link.click()

    const layout = async () => {
      const section = page.getByTestId('attachment-section')
      const parts = section.locator(':scope > *')
      await expect(parts.nth(0)).toContainText('call.ogg')
      await expect(parts.nth(1)).toHaveAttribute('data-testid', 'markdown-attachment')
      await expect(parts.nth(1).getByTestId('markdown-attachment-body')).toHaveText('Shipped it.')
      await expect(parts.nth(2)).toHaveAttribute('data-testid', 'transcript-attachment')
      const toggle = parts.nth(2).getByRole('button', { name: 'Transcript', exact: true })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(parts.nth(2).getByRole('button', { name: 'Seek to 00:04' })).toBeVisible()
    }
    await layout()
    await reopenPage(page, title)
    await layout()
  })
})
