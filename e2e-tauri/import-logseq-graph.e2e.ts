// ---------------------------------------------------------------------------
// Real-backend folder import of a Logseq graph (#6033).
//
// The frontend titles a graph's pages and journals as Logseq does
// (`src/lib/logseq-import.ts`): `pages/<ns>___b.md` is the page `<ns>/b`, and
// `journals/2026_10_21.md` the page `2026-10-21`, its link `[[Oct 21st, 2026]]`
// written `[[2026-10-21]]`; the graph's own `logseq/` folder is not imported.
// Only the backend decides that a page titled `2026-10-21` is that day's
// journal page (`get_journal_page_by_date`) and resolves the link to it, so
// both are asserted here after a navigation round-trip, on what it stored.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  blockStaticByMarker,
  importFolder,
  invoke,
  navigateTo,
  openPageTitled,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

interface BlockRow {
  id: string
  content: string | null
}

describe('Agaric real-backend Logseq graph import (#6033) @markdown @journal @pages', () => {
  it('imports a namespaced page and a journal, the link to it naming its day', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-6033')
    const namespaced = `${marker}/b`
    // Three notes, of which the backup under `logseq/` is no page: two files import.
    await importFolder(
      'import-folder-input',
      `${marker}-graph`,
      {
        'logseq/config.edn': Buffer.from(
          '{:journal/page-title-format "MMM do, yyyy"\n :file/name-format :triple-lowbar}\n',
        ),
        [`logseq/bak/pages/${marker}___b/2026.md`]: Buffer.from(`- ${marker}-backup\n`),
        [`pages/${marker}___b.md`]: Buffer.from(`- ${marker}-link [[Oct 21st, 2026]]\n`),
        'journals/2026_10_21.md': Buffer.from(`- ${marker}-day\n`),
      },
      'Imported “2 files”',
    )

    await navigateTo('Journal')
    await navigateTo('Pages')

    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const spaceId = spaces.find((space) => space.name === 'Personal')?.id
    if (spaceId === undefined) throw new Error('list_spaces returned no Personal space')
    const scope = { kind: 'active', space_id: spaceId }
    const journal = await invoke<BlockRow | null>('get_journal_page_by_date', {
      date: '2026-10-21',
      scope,
    })
    if (journal === null) throw new Error('2026-10-21 has no journal page')
    const { blocks } = await invoke<{ blocks: BlockRow[] }>('load_page_subtree', {
      rootBlockId: journal.id,
      scope,
    })
    expect(blocks.some((block) => block.content?.includes(`${marker}-day`) === true)).toBe(true)

    await openPageTitled(namespaced)
    const link = blockStaticByMarker(`${marker}-link`)
    await link.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const row = $(`li[data-block-id="${await link.getAttribute('data-block-id')}"]`)
    const chip = row.$('[data-testid="block-link-chip"]')
    await browser.waitUntil(async () => (await chip.getAttribute('data-id')) === journal.id, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: '[[Oct 21st, 2026]] never resolved to the journal page of 2026-10-21',
    })
  })
})
