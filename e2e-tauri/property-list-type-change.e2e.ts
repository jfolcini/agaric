// ---------------------------------------------------------------------------
// Real-backend: changing a text key to a list in Settings › Properties (#6741).
//
// A text key is declared and a page holds `Ann, Bob` under it, both through
// the real IPC: the setup is not under test. Its *Change type…* dialog keeps
// the type, ticks "Holds several values" and splits at commas; the preview
// converts the one value, and `change_property_type` writes the definition
// and the value in one op, through the engine and SQL. The page's value, read
// again from the backend, is the list of `Ann` and `Bob`. The toast's Undo
// puts the text back; after leaving Settings and coming back, the key is
// listed as text again and the backend holds `Ann, Bob` as one text.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  navigateTo,
  openSettingsTab,
  runScopedMarker,
  waitForAppReady,
  waitForToast,
} from './helpers'

const KEY = runScopedMarker('wdio-authors')
const PAGE = runScopedMarker('wdio-authors-page')
const TEXT = 'Ann, Bob'
const PANEL = '[data-testid="settings-panel-properties"]'
const DIALOG = '[role="dialog"]'
const CHANGED = `Changed ${KEY} to text · several values`

interface PropertyRow {
  key: string
  value_text: string | null
  value_list?: Array<string | number | null> | null
}

/** Whether the open dialog's text includes `text`, read in one command. */
async function dialogShows(text: string): Promise<boolean> {
  return browser.execute(
    (sel: string, wanted: string) =>
      (document.querySelector(sel)?.textContent ?? '').includes(wanted),
    DIALOG,
    text,
  )
}

/** The page's row of `KEY`, read again from the backend. */
async function heldRow(pageId: string): Promise<PropertyRow | undefined> {
  const rows = await invoke<PropertyRow[]>('get_properties', { blockId: pageId })
  return rows.find((row) => row.key === KEY)
}

/** Wait until the page's row of `KEY` holds `text` and no list. */
async function expectText(pageId: string, when: string): Promise<void> {
  let seen: PropertyRow | undefined
  await browser
    .waitUntil(
      async () => {
        seen = await heldRow(pageId)
        return seen?.value_text === TEXT && seen.value_list == null
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${KEY} does not hold ${TEXT} as text ${when}: ${JSON.stringify(seen)}`)
    })
}

/** The text of `KEY`'s row in the definitions list, read in one command. */
function definitionRowText(): Promise<string> {
  return browser.execute(
    (sel: string) => document.querySelector(sel)?.closest('li')?.textContent ?? '',
    `${PANEL} button[aria-label="Change the type of ${KEY}"]`,
  )
}

describe('Agaric real-backend property type change to a list (#6741) @settings @editor', () => {
  it('splits a comma-joined text into a list, and the toast’s Undo brings the text back', async () => {
    await waitForAppReady()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const spaceId = spaces.find((space) => space.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error('no Personal space')
    await invoke('create_property_def', {
      spaceId,
      key: KEY,
      valueType: 'text',
      options: null,
      multiple: null,
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
        value_text: TEXT,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })

    await openSettingsTab('properties')
    const change = $(`${PANEL} button[aria-label="Change the type of ${KEY}"]`)
    await change.waitForClickable({ timeout: ACTION_TIMEOUT })
    await change.click()
    // The dialog's one checkbox: "Holds several values".
    const several = $(DIALOG).$('[role="checkbox"]')
    await several.waitForClickable({ timeout: ACTION_TIMEOUT })
    await several.click()
    const commas = $(DIALOG).$('[role="radio"]*=Split at commas')
    await commas.waitForClickable({ timeout: ACTION_TIMEOUT })
    await commas.click()
    await browser.waitUntil(() => dialogShows('1 value is converted.'), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the dialog never previewed the one value converted',
    })
    const confirm = $(DIALOG).$('button*=Change type')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    await waitForToast(CHANGED)

    const row = await heldRow(pageId)
    expect(row?.value_list).toEqual(['Ann', 'Bob'])
    expect(row?.value_text).toBeNull()

    // Undo before the toast times out.
    const undo = $(
      `//*[@data-sonner-toast][contains(., "${CHANGED}")]//button[normalize-space()="Undo"]`,
    )
    await undo.waitForClickable({ timeout: ACTION_TIMEOUT })
    await undo.click()
    await expectText(pageId, 'after Undo')

    await navigateTo('Pages')
    await openSettingsTab('properties')
    await browser.waitUntil(
      async () => {
        const text = await definitionRowText()
        return text.includes('text') && !text.includes('several values')
      },
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: `${KEY} is not listed as text after the round-trip`,
      },
    )
    await expectText(pageId, 'after the round-trip')
  })
})
