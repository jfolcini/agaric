// ---------------------------------------------------------------------------
// Real-backend paste of Logseq's highlight and Obsidian's embed (#6033 S4, S5b).
//
// One pasted line holding `^^x^^` goes to the block path, whose save writes it
// as Agaric's `==x==`; text holding `^^` literally, which the editor stores
// escaped, copies and pastes back byte for byte (Q3); and a `![[Note]]` pasted
// into an empty block is stored as an embed of that page. The backend
// normalises, the mock does not, so only this lane can show any of them.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  clipboardText,
  ctrlClick,
  invoke,
  navigateTo,
  openNewPage,
  pastePlainText,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const HIGHLIGHT_PAGE = runScopedMarker('wdio-foreign-paste-page')
const LITERAL_PAGE = runScopedMarker('wdio-foreign-copy-page')
const HEAD = runScopedMarker('wdio-foreign-head')
const TAIL = runScopedMarker('wdio-foreign-tail')
const LITERAL = runScopedMarker('wdio-foreign-literal')
const ESCAPED = `${LITERAL} a \\^\\^b\\^\\^ c`
const NOTE_PAGE = runScopedMarker('wdio-foreign-embed-note')
const NOTE_BODY = runScopedMarker('wdio-foreign-embed-body')
const EMBED_PAGE = runScopedMarker('wdio-foreign-embed-page')
const EMBED_OF_A_PAGE = /^\{\{embed \[\[[0-9A-Z]{26}\]\]\}\}$/

/** The ids of the rows whose text holds `marker`, in document order. */
function rowIds(marker: string): Promise<string[]> {
  return browser.execute(
    (m: string) =>
      Array.from(document.querySelectorAll('[data-testid="sortable-block"]'))
        .filter((row) => (row.textContent ?? '').includes(m))
        .map((row) => row.getAttribute('data-block-id') ?? ''),
    marker,
  )
}

/** The text the backend stores for block `id`. */
async function stored(id: string): Promise<string> {
  return (await invoke<{ content: string }>('get_block', { blockId: id })).content
}

/** The text of the row holding `marker`, as rendered, editor or not. */
function rowText(marker: string): Promise<string> {
  return browser.execute(
    (m: string) =>
      Array.from(document.querySelectorAll('[data-testid="sortable-block"]'))
        .map((row) => row.textContent ?? '')
        .find((text) => text.includes(m)) ?? '',
    marker,
  )
}

describe('Agaric real-backend paste of foreign syntax (#6033) @editor', () => {
  it('stores a pasted line holding ^^x^^ as Agaric’s ==x==', async () => {
    await waitForAppReady()
    await openNewPage(HIGHLIGHT_PAGE)
    await typeMarkerVerified(`${HEAD} ${TAIL}`)
    await browser.keys(['End'])
    for (let i = 0; i < TAIL.length; i++) await browser.keys(['ArrowLeft'])

    await pastePlainText('x ^^y^^')
    await browser.waitUntil(async () => (await rowText(HEAD)).includes(`${HEAD} x `), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the pasted line never landed in the block',
    })
    await navigateTo('Journal')
    await reopenPageByTitle(HIGHLIGHT_PAGE)

    await blockStaticByMarker(HEAD).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const [id] = await rowIds(HEAD)
    expect(await stored(id as string)).toBe(`${HEAD} x ==y==${TAIL}`)
  })

  it('pastes a copy of text holding ^^ literally back byte for byte', async () => {
    await openNewPage(LITERAL_PAGE)
    await typeMarkerVerified(`${LITERAL} a ^^b^^ c`)
    // Escape commits the block and leaves it selected (#5160 D17); the second
    // clears that selection so the Ctrl+click below starts from none.
    await browser.keys(['Escape'])
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    await browser.keys(['Escape'])
    // The editor stores the text escaped, so no paste reads it as a highlight.
    const [original] = await rowIds(LITERAL)
    await browser.waitUntil(async () => (await stored(original as string)) === ESCAPED, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the block was not stored as ${ESCAPED}`,
    })

    await ctrlClick(blockStaticByMarker(LITERAL))
    await browser.keys(['Control', 'c'])
    await browser.waitUntil(async () => (await clipboardText()).includes(LITERAL), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+C never put the block on the clipboard',
    })
    await browser.keys(['Control', 'v'])
    await browser.waitUntil(async () => (await rowIds(LITERAL)).length === 2, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+V did not paste a copy of the block',
    })
    await navigateTo('Journal')
    await reopenPageByTitle(LITERAL_PAGE)

    await blockStaticByMarker(LITERAL).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const ids = await rowIds(LITERAL)
    expect(ids.length).toBe(2)
    const texts = await Promise.all(ids.map(stored))
    expect(texts).toEqual([ESCAPED, ESCAPED])
  })

  it('stores a pasted ![[Note]] as an embed of the page', async () => {
    await openNewPage(NOTE_PAGE)
    await typeMarkerVerified(NOTE_BODY)
    await browser.keys(['Escape'])
    await openNewPage(EMBED_PAGE)
    const [id] = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="sortable-block"]')).map(
        (row) => row.getAttribute('data-block-id') ?? '',
      ),
    )

    await pastePlainText(`![[${NOTE_PAGE}]]`)
    await browser.waitUntil(async () => EMBED_OF_A_PAGE.test(await stored(id as string)), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the pasted embed was never stored as {{embed [[ULID]]}}',
    })
    await navigateTo('Journal')
    await reopenPageByTitle(EMBED_PAGE)

    const embed = $(`li[data-block-id="${id as string}"] [data-testid="embed-container"]`)
    await browser.waitUntil(async () => (await embed.getText()).includes(NOTE_BODY), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the embed never showed the note',
    })
    expect(await stored(id as string)).toMatch(EMBED_OF_A_PAGE)
  })
})
