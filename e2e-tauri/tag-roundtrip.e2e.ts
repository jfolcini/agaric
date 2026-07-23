// ---------------------------------------------------------------------------
// Real-backend tag round-trip (#3085, regression for #3081).
//
// #3081: creating a tag then navigating away and back made it VANISH, because
// the space-scope stamp (the `SetProperty(key='space')` that makes a new tag
// surface in `listAllTagsInSpace`) was best-effort. The fix
// (fix/3081-tag-space-scope-atomic) makes tags space-scoped atomically. This
// spec asserts the INTENDED durable behaviour against the REAL backend: a tag
// created via the Tags-view UI survives a Journal round-trip and is still
// listed on return. It is precisely the mock-vs-real / durable-state bug class
// #3082 wants dead — the JS mock never exhibited the orphaned-tag drift, so
// only a live-backend spec can guard it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { ACTION_TIMEOUT, NAV_TIMEOUT, navigateTo, waitForAppReady } from './helpers'

// Fixed, hyphenated marker: unique within this spec file. WDIO runs against
// fresh app data each CI run, so a stable name cannot collide across runs; the
// hyphens keep both the typed input and the `tag-item-<name>` testid clean.
const TAG_NAME = 'wdio-tag-roundtrip'

describe('Agaric real-backend tag round-trip (#3085 / #3081)', () => {
  it('keeps a UI-created tag listed after navigating away to Journal and back', async () => {
    await waitForAppReady()

    // 1. Open the Tags view. `aria-current="page"` confirms the switch.
    await navigateTo('Tags')

    // 2. Create a tag via the TagList inline form. The text input's accessible
    //    name is `tagList.newTagLabel` ("New tag name"); the submit button's
    //    visible text is `tag.addTag` ("Add Tag"). (TagList.tsx: the <Input>
    //    aria-label + the <Button type="submit">.)
    const nameInput = $('[aria-label="New tag name"]')
    await nameInput.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await nameInput.click()
    await browser.keys(TAG_NAME.split(''))

    const addTag = $('button*=Add Tag')
    await addTag.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addTag.click()

    // 3. The new tag renders as a clickable list item whose testid is
    //    `tag-item-<name>` (TagList.tsx, the per-tag <button data-testid>).
    //    Its appearance proves the create op + space-scope write round-tripped
    //    through the live backend.
    const tagItem = $(`[data-testid="tag-item-${TAG_NAME}"]`)
    await tagItem.waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // 4. Navigate AWAY to the Journal, then BACK to Tags. Pre-fix, the tag —
    //    left an orphan with no `space` property — would not be returned by
    //    `listAllTagsInSpace` on the reload and would disappear here.
    await navigateTo('Journal')
    await navigateTo('Tags')

    // 5. The Tags view re-queries the backend on mount. Assert the tag is STILL
    //    listed — the #3081 regression guard.
    const tagItemAfter = $(`[data-testid="tag-item-${TAG_NAME}"]`)
    await tagItemAfter.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(tagItemAfter).toBeDisplayed()
  })
})
