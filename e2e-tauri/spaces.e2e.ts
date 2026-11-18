// ---------------------------------------------------------------------------
// Real-backend spaces: delete (#5739). Settings › Spaces enables Delete only
// for a space whose scoped `list_blocks` probe finds no page (SpacesTab.tsx).
// The mock ignores the scope, so it disables Delete for every space. Move to
// space and the window title are `e2e/spaces-move-and-title.spec.ts`.
//
// A real vault boots with the spaces Personal and Work (spaces/bootstrap.rs).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  confirmDialog,
  navigateTo,
  openNewPage,
  runScopedMarker,
  switchToSpace,
  waitForAppReady,
  createSpace,
  openSpacesSettings,
  spaceRows,
  waitForSpaceRows,
} from './helpers'

const SWITCHER = '[aria-label="Switch space"]'

/** The names the open switcher offers, read and then closed with Escape. */
async function switcherOptions(): Promise<string[]> {
  const trigger = $(SWITCHER)
  await trigger.waitForClickable({ timeout: ACTION_TIMEOUT })
  await trigger.click()
  await $('[role="option"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const options = await browser.execute(() =>
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? ''),
  )
  await browser.keys(['Escape'])
  await $('[role="option"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  return options
}

describe('Agaric real-backend spaces (#5739) @spaces', () => {
  before(async () => {
    await waitForAppReady()
  })

  it('deletes an empty space after confirming, and refuses one that holds a page', async () => {
    const empty = runScopedMarker('wdio-empty-space')
    const full = runScopedMarker('wdio-full-space')
    const page = runScopedMarker('wdio-full-page')

    await openSpacesSettings()
    await createSpace(empty)
    await createSpace(full)
    await switchToSpace(full)
    await openNewPage(page)

    await openSpacesSettings()
    await waitForSpaceRows(
      (rows) =>
        rows.some((row) => row.name === empty && !row.deleteDisabled) &&
        rows.some((row) => row.name === full && row.deleteDisabled && row.blockedHint),
      `Delete is not enabled for ${empty} and refused for ${full}`,
    )
    const index = (await spaceRows()).findIndex((row) => row.name === empty)
    const deleteButton = (await $$('[data-slot="space-manage-row"]').getElements())[index]?.$(
      'button[aria-label="Delete space"]',
    )
    if (deleteButton === undefined) throw new Error(`no Settings › Spaces row for ${empty}`)
    await deleteButton.click()
    await confirmDialog('Delete')

    // Re-opening Settings probes every space's emptiness afresh.
    await navigateTo('Journal')
    await openSpacesSettings()
    await waitForSpaceRows(
      (rows) =>
        !rows.some((row) => row.name === empty) &&
        rows.some((row) => row.name === full && row.deleteDisabled && row.blockedHint),
      `${empty} is still listed, or ${full} lost its refusal`,
    )
    const options = await switcherOptions()
    expect(options.some((option) => option.includes(full))).toBe(true)
    expect(options.some((option) => option.includes(empty))).toBe(false)
  })
})
