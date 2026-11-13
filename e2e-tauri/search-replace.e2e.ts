// ---------------------------------------------------------------------------
// Real-backend replace across pages from the Search view (#6608).
//
// One `edit_blocks_batch` writes every ticked block. This lane shows what the
// mock cannot: the search index follows the write (the old word stops finding
// the replaced blocks, the new one finds them), the toast's Undo reverts a
// run's ops on both pages in one `undo_ops`, and Ctrl+Z on a page opened after
// a run undoes that page's part only, by the op log's own grouping. An
// unticked block keeps the old word, so the old word's results are known to
// have arrived when the replaced blocks are missing from them.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  blockStaticByMarker,
  importMarkdownPage,
  invoke,
  navigateTo,
  openPageTitled,
  reopenPageHolding,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
  waitForResults,
  waitForToast,
} from './helpers'

// Plain words with no letter doubled (see `runScopedMarker`), none inside another.
const OLD = runScopedMarker('wdio-amber')
const NEW = runScopedMarker('wdio-cobalt')
const NEWER = runScopedMarker('wdio-indigo')
// Not holding any of the words, so no title row is a result.
const TITLE_A = runScopedMarker('wdio-swap-one')
const TITLE_B = runScopedMarker('wdio-swap-two')

const TOGGLE = '[data-testid="search-replace-toggle"]'
const REPLACE_INPUT = '[data-testid="search-replace-input"]'
const RUN = '[data-testid="search-replace-run"]'
const DONE = 'Replaced in 3 blocks across 2 pages'

const contentOf = async (id: string): Promise<string> =>
  (await invoke<{ content: string | null }>('get_block', { blockId: id })).content ?? ''

/** The ids of the listed results, by the first word of each block's text. */
async function idsByFirstWord(): Promise<Record<string, string>> {
  const ids = await browser.execute(() =>
    [...document.querySelectorAll('[data-testid^="search-result-row-"]')].map(
      (row) => row.getAttribute('data-testid')?.slice('search-result-row-'.length) ?? '',
    ),
  )
  const byWord: Record<string, string> = {}
  for (const id of ids) byWord[(await contentOf(id)).split(' ')[0] ?? ''] = id
  return byWord
}

async function waitForContents(expected: Record<string, string>, what: string): Promise<void> {
  let seen: Record<string, string> = {}
  await browser
    .waitUntil(
      async () => {
        seen = {}
        for (const id of Object.keys(expected)) seen[id] = await contentOf(id)
        return Object.entries(expected).every(([id, text]) => seen[id] === text)
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}; the blocks held ${JSON.stringify(seen)}`)
    })
}

/** Open the replace row on the listed search, type `replacement` and wait for the preview's `label`. */
async function previewReplace(replacement: string, label: string): Promise<void> {
  await $(TOGGLE).waitForClickable({ timeout: ACTION_TIMEOUT })
  await $(TOGGLE).click()
  await typeInputVerified(REPLACE_INPUT, replacement)
  await browser.waitUntil(async () => (await $(RUN).getText()) === label, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the replace button never read ${JSON.stringify(label)}`,
  })
}

/** Press the replace button, confirm, and wait for the run's toast. */
async function runReplace(): Promise<void> {
  await $(RUN).click()
  const confirm = $('[data-testid="search-replace-confirm"]')
  await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
  await confirm.click()
  // A pointer left where the toast slides in holds the stack open (`clickPageSourceButton`).
  await browser.action('pointer').move({ x: 2, y: 2, origin: 'viewport' }).perform()
  await waitForToast(DONE)
}

describe('Agaric real-backend replace across pages (#6608) @search @pages @editor', () => {
  it('reindexes the replaced blocks, undoes a run from its toast, and Ctrl+Z undoes one page of a run', async () => {
    await waitForAppReady()
    await importMarkdownPage(TITLE_A, `- one ${OLD}\n- two ${OLD}\n`)
    await importMarkdownPage(TITLE_B, `- three ${OLD}\n- kept ${OLD}\n`)

    await navigateTo('Search')
    await waitForResults(OLD, (ids) => ids.length === 4, 'the imported blocks were never found')
    const { one, two, three, kept } = await idsByFirstWord()
    if (!one || !two || !three || !kept)
      throw new Error('a seeded block is missing from the results')
    const replaced = [one, two, three]

    // Run 1: every block but the unticked one, on both pages.
    await previewReplace(NEW, 'Replace in 4 blocks across 2 pages')
    await $(`[data-testid="search-replace-row-${kept}"]`).click()
    await browser.waitUntil(
      async () => (await $(RUN).getText()) === 'Replace in 3 blocks across 2 pages',
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'unticking a row did not take it out of the run' },
    )
    await runReplace()
    await waitForContents(
      {
        [one]: `one ${NEW}`,
        [two]: `two ${NEW}`,
        [three]: `three ${NEW}`,
        [kept]: `kept ${OLD}`,
      },
      'the replace did not write the ticked blocks only',
    )

    // The index follows: the new word finds the replaced blocks, the old one only the kept block.
    await $(TOGGLE).click()
    await waitForResults(
      NEW,
      (ids) => replaced.every((id) => ids.includes(id)) && !ids.includes(kept),
      'the new word never found the replaced blocks',
    )
    await waitForResults(
      OLD,
      (ids) => ids.includes(kept) && replaced.every((id) => !ids.includes(id)),
      'the old word still finds a replaced block',
    )

    // Each page shows its new text once opened.
    await openPageTitled(TITLE_A)
    await blockStaticByMarker(`one ${NEW}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await blockStaticByMarker(`two ${NEW}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await openPageTitled(TITLE_B)
    await blockStaticByMarker(`three ${NEW}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await blockStaticByMarker(`kept ${OLD}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // Run 2, taken back by its toast: both pages return to the first run's text.
    await navigateTo('Search')
    await waitForResults(
      NEW,
      (ids) => replaced.every((id) => ids.includes(id)),
      'the replaced blocks were not found for the second run',
    )
    await previewReplace(NEWER, 'Replace in 3 blocks across 2 pages')
    await runReplace()
    await waitForContents(
      { [one]: `one ${NEWER}`, [two]: `two ${NEWER}`, [three]: `three ${NEWER}` },
      'the second run did not write',
    )
    await browser.execute(() => {
      const undo = [...document.querySelectorAll('[data-sonner-toast] button')].find(
        (button) => button.textContent === 'Undo',
      )
      if (!(undo instanceof HTMLElement)) throw new Error('the replace toast offers no Undo')
      undo.click()
    })
    await waitForContents(
      { [one]: `one ${NEW}`, [two]: `two ${NEW}`, [three]: `three ${NEW}` },
      "the toast's Undo did not restore both pages",
    )
    await openPageTitled(TITLE_B)
    await blockStaticByMarker(`three ${NEW}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // Run 3, then Ctrl+Z on one of its pages: that page's blocks only.
    await navigateTo('Search')
    await waitForResults(
      NEW,
      (ids) => replaced.every((id) => ids.includes(id)),
      'the restored blocks were not found for the third run',
    )
    await previewReplace(NEWER, 'Replace in 3 blocks across 2 pages')
    await runReplace()
    await waitForContents(
      { [one]: `one ${NEWER}`, [two]: `two ${NEWER}`, [three]: `three ${NEWER}` },
      'the third run did not write',
    )
    await openPageTitled(TITLE_A)
    await blockStaticByMarker(`one ${NEWER}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'z'])
    await waitForContents(
      { [one]: `one ${NEW}`, [two]: `two ${NEW}`, [three]: `three ${NEWER}` },
      "Ctrl+Z did not undo the opened page's part of the run alone",
    )
    await reopenPageHolding(TITLE_A, `one ${NEW}`)
    await blockStaticByMarker(`two ${NEW}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
  })
})
