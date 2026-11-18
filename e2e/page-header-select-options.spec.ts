import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, ipc, openPage, test, waitForBoot } from './helpers'

/**
 * #6946 — the page header's select offers an option added to its definition
 * elsewhere (Settings in another window, a synced device, MCP) without leaving
 * the page. The seeded Personal space declares `project` as a select of alpha,
 * beta and gamma. The write goes through IPC so the page stays open; the mock's
 * change feed answers it as the backend's does, and the header reads the
 * definitions through the query that feed invalidates.
 */

test('the header select offers an option added to the definition elsewhere @pages', async ({
  page,
}) => {
  await waitForBoot(page)
  await ipc(page, 'set_property', {
    blockId: SEED_IDS.PAGE_GETTING_STARTED,
    key: 'project',
    value: {
      value_text: 'alpha',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    },
  })
  await openPage(page, 'Getting Started')
  await page.getByRole('button', { name: /^Properties/ }).click()
  const select = page.getByRole('combobox', { name: 'project value', exact: true })

  await select.click()
  await expect(page.getByRole('option', { name: 'gamma', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'delta', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await ipc(page, 'update_property_def_options', {
    spaceId: SEED_IDS.SPACE_PERSONAL,
    key: 'project',
    options: '["alpha","beta","gamma","delta"]',
  })

  await select.click()
  await expect(page.getByRole('option', { name: 'delta', exact: true })).toBeVisible()
})
