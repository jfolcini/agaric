// ---------------------------------------------------------------------------
// Real-backend: the values that don't fit a property, in Settings › Properties
// (#6206).
//
// A select is declared with the options alpha and beta, a page holds beta,
// and the options are narrowed to alpha: beta no longer fits. Settings ›
// Properties shows the select's "1 doesn't fit" badge, its dialog lists the
// page's beta, and Remove takes it off in one `rewrite_properties` op through
// the engine and the SQL projection; the badge goes. The toast's Undo puts it
// back. After leaving Settings and coming back, the counts are read again from
// the backend: the badge is still there.
//
// The definition and the value are set through the real IPC: the setup is not
// under test.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  invoke,
  navigateTo,
  openSettingsTab,
  runScopedMarker,
  waitForAppReady,
  waitForToast,
} from './helpers'

const KEY = runScopedMarker('wdio-unfit')
const PAGE = runScopedMarker('wdio-unfit-page')
const PANEL = '[data-testid="settings-panel-properties"]'
const BADGE = `${PANEL} [data-testid="property-unfit-${KEY}"]`
const DIALOG = '[role="dialog"]'
const REMOVED = `Removed 1 value of ${KEY} that didn't fit`

/** Whether the open dialog's text includes `text`, read in one command. */
async function dialogShows(text: string): Promise<boolean> {
  return browser.execute(
    (sel: string, wanted: string) =>
      (document.querySelector(sel)?.textContent ?? '').includes(wanted),
    DIALOG,
    text,
  )
}

/** The badge reads `1 doesn't fit`, polled with a fresh find each time. */
async function expectBadge(when: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const badges = await $$(BADGE).getElements()
      return badges.length === 1 && (await badges[0]?.getText()) === "1 doesn't fit"
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `no "1 doesn't fit" badge on ${KEY} ${when}` },
  )
}

describe("Agaric real-backend values that don't fit a property (#6206) @settings", () => {
  it("removes them, and the toast's Undo puts them back, read again after a round-trip", async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const spaceId = spaces.find((space) => space.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error('no Personal space')
    await invoke('create_property_def', {
      spaceId,
      key: KEY,
      valueType: 'select',
      options: '["alpha","beta"]',
    })
    const pageId = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: PAGE,
      spaceId,
    })
    await invoke('set_property', {
      blockId: pageId,
      key: KEY,
      value: {
        value_text: 'beta',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    await invoke('update_property_def_options', { spaceId, key: KEY, options: '["alpha"]' })

    await openSettingsTab('properties')
    await expectBadge('after its options lost beta')
    const badge = $(BADGE)
    await badge.waitForClickable({ timeout: ACTION_TIMEOUT })
    await badge.click()
    await browser.waitUntil(
      async () =>
        (await dialogShows("1 value doesn't fit.")) &&
        (await dialogShows(PAGE)) &&
        (await dialogShows('Not one of the options')),
      {
        timeout: ACTION_TIMEOUT,
        timeoutMsg: "the dialog never listed the page's beta as not one of the options",
      },
    )
    const remove = $(DIALOG).$('button=Remove')
    await remove.waitForClickable({ timeout: ACTION_TIMEOUT })
    await remove.click()
    // The toast says the backend removed it; Undo before the toast times out.
    await waitForToast(REMOVED)
    await expectAbsent(BADGE, 'the badge after Remove')
    const undo = $(
      `//*[@data-sonner-toast][contains(., "${REMOVED}")]//button[normalize-space()="Undo"]`,
    )
    await undo.waitForClickable({ timeout: ACTION_TIMEOUT })
    await undo.click()
    await expectBadge('after Undo')

    await navigateTo('Pages')
    await openSettingsTab('properties')
    await expectBadge('after the round-trip')
  })
})
