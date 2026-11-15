// ---------------------------------------------------------------------------
// Real-backend import of Logseq `{{query …}}` simple queries (#6754).
//
// The frontend rewrites a macro whose every clause has an equivalent into the
// search syntax's query block (`[[tag]]` as `under:#tag`, which sees the inline
// `#tag` an import stores as a reference, not as an attached tag) (`src/lib/logseq-query.ts`), and keeps any other
// in a `logseq-query` code block, counted in one import warning. Only this
// lane can show that the imported block is live: its results come from the
// backend's search over the tag and task state the importer stored, read by a
// page editor that mounts fresh after navigating away and back. The mock's
// `import_markdown` models neither the Logseq `TODO` keyword nor the tag index
// the query reads.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  blockStaticByMarker,
  importFolder,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-lq')
// Letters, digits and `-` only, so the bare `#name` is the whole tag.
const TAG = `${MARKER}-tag`
const TITLE = `${MARKER}-dash`
const HIT = `${MARKER}-hit`
const MISS = `${MARKER}-miss`
const UNTRANSLATABLE = '{{query (between -7d today)}}'

/** The text of each result the page's query blocks draw. */
function resultTexts(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="query-result-item"]')].map(
      (el) => el.textContent ?? '',
    ),
  )
}

describe('Agaric real-backend Logseq query import (#6754) @markdown @search', () => {
  it('imports a translatable query as a live query block and keeps the other as a counted code block', async () => {
    await waitForAppReady()
    const page = [
      `- {{query (and (task TODO) [[${TAG}]])}}`,
      `- ${UNTRANSLATABLE}`,
      `- TODO ${HIT} #${TAG}`,
      `- DONE ${MISS} #${TAG}`,
      '',
    ].join('\n')
    await importFolder(
      'import-folder-input',
      `${MARKER}-graph`,
      {
        'logseq/config.edn': Buffer.from('{:file/name-format :triple-lowbar}\n'),
        [`pages/${TITLE}.md`]: Buffer.from(page),
      },
      `Imported “${TITLE}”`,
    )
    // One query the import could not translate: one warning for it, not one per block.
    // The list may hold warnings that are not about queries, so only the query one is read.
    const warnings = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="import-warning-item"]')].map(
        (el) => el.textContent ?? '',
      ),
    )
    expect(warnings.filter((text) => text.includes('Logseq quer'))).toEqual([
      '1 Logseq query has no equivalent here and was kept as a code block to rebuild.',
    ])

    // Navigate away and back, so the page editor mounts from a fresh backend read.
    await navigateTo('Journal')
    await reopenPageByTitle(TITLE)

    // The query block lists the open task of the tag, never the done one.
    await browser.waitUntil(async () => (await resultTexts()).some((text) => text.includes(HIT)), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the imported query block never listed the open tagged task',
    })
    expect((await resultTexts()).some((text) => text.includes(MISS))).toBe(false)

    // The query it could not translate is still on the page, as written, under a marker line.
    const kept = blockStaticByMarker('between')
    await kept.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await kept.getText()).toContain(UNTRANSLATABLE)
    expect(await kept.getText()).toContain('Logseq query, not translated:')
  })
})
