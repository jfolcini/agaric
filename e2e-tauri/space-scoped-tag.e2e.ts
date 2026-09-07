// ---------------------------------------------------------------------------
// Real-backend space-scoped tag creation — the #3081 flow (#4671).
//
// #3081 was a genuine atomicity defect: a tag created from the editor was a
// durable orphan create followed by a best-effort `set_property(space)` whose
// failure was swallowed, so the tag existed but `list_all_tags_in_space`
// never returned it after a view switch. Every mock-backed lane stayed green
// because the mock read a retired contract. The fix routes an inline tag
// create through `create_tag_in_space_inner` (commands/blocks/crud.rs):
// CreateBlock + SetProperty(space) in one transaction. This spec drives that
// exact flow — a second space, a tag typed inline with the `@` picker — and
// asserts the tag is listed in that space, absent from the first space, and
// listed again on return. The Tags view does not re-query on a space switch
// (TagList.tsx reads the space imperatively on mount), so every read here is
// a Journal → Tags round-trip, which is also what makes each read durable.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  expectAbsent,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const SPACE_B = runScopedMarker('wdio-space')
const TAG = runScopedMarker('wdio-scoped')
const SWITCHER = '[aria-label="Switch space"]'
const TAG_ITEM = `[data-testid="tag-item-${TAG}"]`

/**
 * The switcher trigger's label, read as DOM text rather than through
 * `getText()`.
 *
 * `getText()` returns "" for this button — run 34088762135 polled it for the
 * full 60 s while the failure screenshot shows the trigger plainly reading
 * "Personal". The label is not the button's own text: Radix's `SelectValue`
 * is a portal TARGET, and the selected `SelectItemText` renders into it from
 * a subtree the closed Select keeps hidden, which WebDriver's rendered-text
 * algorithm does not follow. `textContent` does, and it is unaffected by the
 * trigger's `text-overflow: ellipsis` truncation either.
 */
async function switcherLabel(): Promise<string> {
  const label = await browser.execute(
    (selector: string) => document.querySelector(selector)?.textContent ?? '',
    SWITCHER,
  )
  return label.trim()
}

/**
 * The active space's name, once the switcher has one to show. SpaceSwitcher
 * fills `availableSpaces` from a fire-and-forget `refreshAvailableSpaces()`
 * on mount, so until that lands no item matches `currentSpaceId` and the
 * trigger really is empty; the app-ready signal does not cover that store.
 */
async function currentSpaceName(): Promise<string> {
  let name = ''
  await browser.waitUntil(
    async () => {
      name = await switcherLabel()
      return name !== ''
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: 'the space switcher never showed an active space' },
  )
  return name
}

async function switchToSpace(name: string): Promise<void> {
  await chooseSelectOption(SWITCHER, name)
  await browser.waitUntil(async () => (await switcherLabel()).includes(name), {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `space switcher never showed ${JSON.stringify(name)}`,
  })
}

describe('Agaric real-backend space-scoped tag (#4671 / #3081)', () => {
  it('lists an inline-created tag only in the space it was created in, across switches', async () => {
    await waitForAppReady()
    const spaceA = await currentSpaceName()

    // 1. Create space B through the manage dialog (creating does not switch).
    await chooseSelectOption(SWITCHER, 'Manage spaces')
    const dialog = $('[data-testid="space-manage-dialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const create = dialog.$('button[aria-label="Create new space"]')
    await create.waitForClickable({ timeout: ACTION_TIMEOUT })
    await create.click()
    await typeInputVerified('[aria-label="New space name"]', SPACE_B)
    await browser.keys(['Enter'])
    await browser.waitUntil(
      async () => {
        const rows = await dialog.$$('[aria-label="Rename space"]').getElements()
        const values = await rows.map((row) => row.getValue())
        return values.includes(SPACE_B)
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the new space never appeared in the manage dialog' },
    )
    await browser.keys(['Escape'])
    await dialog.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    // 2. Switch to B and create the tag inline: `@name` opens the tag picker
    //    whose first item is "Create <name>" (use-block-resolve.ts
    //    `searchTags`); Enter creates the tag row in the backend and inserts
    //    the chip, then Enter commits the block and Escape leaves the editor.
    await switchToSpace(SPACE_B)
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(`@${TAG}`)
    await $('[data-testid="suggestion-item"]*=Create').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Enter'])
    await $('[data-testid="block-editor"] [data-testid="tag-ref-chip"]').waitForExist({
      timeout: ACTION_TIMEOUT,
    })
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])

    // 3. Present in B.
    await navigateTo('Tags')
    await $(TAG_ITEM).waitForDisplayed({ timeout: NAV_TIMEOUT })

    // 4. Absent in A. The empty state is the "list has loaded" signal that
    //    makes the absence check meaningful: EmptyState.tsx stamps the
    //    message (`tagList.empty`) as the root's aria-label.
    await switchToSpace(spaceA)
    await navigateTo('Journal')
    await navigateTo('Tags')
    await $(
      '[aria-label="No tags yet. Create one above to organize your blocks."]',
    ).waitForDisplayed({
      timeout: NAV_TIMEOUT,
    })
    await expectAbsent(TAG_ITEM, 'the space-B tag')

    // 5. Present again in B.
    await switchToSpace(SPACE_B)
    await navigateTo('Journal')
    await navigateTo('Tags')
    const again = $(TAG_ITEM)
    await again.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(again).toBeDisplayed()
  })
})
