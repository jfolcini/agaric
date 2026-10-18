// ---------------------------------------------------------------------------
// Real-backend property lines in Edit as Markdown (#5365).
//
// The source buffer writes each block property as a `key:: value` line under
// its bullet, and Save reads it back through `apply_page_source`: a new or
// edited line sets the property, a line with no value deletes it (#5160 P7),
// and a value the backend refuses (a `repeat::` rule the recurrence engine
// cannot read) refuses the whole save, naming the line, and writes nothing.
// The mock's `apply_page_source` models none of these lines
// (`src/lib/tauri-mock/handlers/pages.ts`), so only this lane runs them.
//
// Two tests in one vault, on the one page the first creates.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  navigateTo,
  openNewPage,
  openPageSource,
  clickPageSourceButton,
  pageSourceLines,
  pageSourceText,
  reopenPageByTitle,
  runScopedMarker,
  type SourceLine,
  setPageSourceLines,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-propline')
const EDITED = runScopedMarker('wdio-propline-refused')
// A key no definition spells or folds to is a custom text property.
const KEY = 'wdiokey'
const FIRST = runScopedMarker('wdio-propline-one')
const SECOND = runScopedMarker('wdio-propline-two')
const REFUSED_RULE = 'repeat:: every tuesday'

// Property chips render in the block's metadata row, outside its
// `block-static` text, so a chip holding the value and no static text holding
// it is "stored as the property, not kept as text".
const chipWith = (value: string) => `[data-testid="property-chip"]*=${value}`
const staticWith = (text: string) => `[data-testid="block-static"]*=${text}`

/** Leave the page editor and come back, so the rows are the backend's. */
async function reopenTheNewPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await $(staticWith(MARKER)).waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** The buffer's lines with `edit` applied to the marked block's lines. */
function editMarkedBlock(
  lines: SourceLine[],
  edit: (block: SourceLine[]) => SourceLine[],
): SourceLine[] {
  const start = lines.findIndex((line) => line.id !== null && line.text.includes(MARKER))
  if (start === -1) throw new Error('the buffer holds no line for the marked block')
  let end = start + 1
  while (end < lines.length && lines[end]?.id === null && lines[end]?.text !== '') end += 1
  return [...lines.slice(0, start), ...edit(lines.slice(start, end)), ...lines.slice(end)]
}

/** Write `lines` into the open buffer and press Save. */
async function saveLines(lines: SourceLine[]): Promise<void> {
  await setPageSourceLines(lines)
  await clickPageSourceButton('Save')
}

/** Edit the marked block in Edit as Markdown and save it, closing the buffer. */
async function saveMarkedBlock(
  shown: string[],
  edit: (block: SourceLine[]) => SourceLine[],
): Promise<void> {
  const source = await openPageSource([MARKER, ...shown])
  await saveLines(editMarkedBlock(await pageSourceLines(), edit))
  await source.waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'Save did not close source mode',
  })
}

describe('Agaric real-backend property lines in Edit as Markdown (#5365) @editor @pages @markdown', () => {
  it('a property line sets, edits and, left empty, deletes the property', async () => {
    await waitForAppReady()
    // The sidebar click commits the typed marker by blurring the editor.
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await reopenTheNewPage()

    await saveMarkedBlock([], (block) => [...block, { text: `  ${KEY}:: ${FIRST}`, id: null }])
    await reopenTheNewPage()
    await $(chipWith(FIRST)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(staticWith(FIRST), 'the property line kept as text')

    await saveMarkedBlock([`${KEY}:: ${FIRST}`], (block) =>
      block.map(({ text, id }) => ({ id, text: text.replace(FIRST, SECOND) })),
    )
    await reopenTheNewPage()
    await $(chipWith(SECOND)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(chipWith(FIRST), 'the value the edit replaced')

    await saveMarkedBlock([`${KEY}:: ${SECOND}`], (block) =>
      block.map(({ text, id }) => ({ id, text: text.includes(KEY) ? `  ${KEY}::` : text })),
    )
    await reopenTheNewPage()
    // The buffer is the page re-read from the backend: once it holds the
    // marker it is loaded, and a property still stored, or the emptied line
    // kept as text, would be a line of it.
    const source = await openPageSource([MARKER])
    expect(await pageSourceText()).not.toContain(KEY)
    // An unchanged buffer closes on Cancel without asking.
    await clickPageSourceButton('Cancel')
    await source.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  })

  it('a refused repeat rule blocks the save, names its line and writes nothing', async () => {
    await reopenTheNewPage()
    const source = await openPageSource([MARKER])
    // The same save also edits the block's text, so a save that wrote part of
    // itself before refusing shows.
    await saveLines(
      editMarkedBlock(await pageSourceLines(), (block) => [
        ...block.map(({ text, id }) => ({ id, text: text.replace(MARKER, EDITED) })),
        { text: `  ${REFUSED_RULE}`, id: null },
      ]),
    )
    const refusal = $(`p[role="alert"]*=${REFUSED_RULE}`)
    await refusal.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    expect(await refusal.getText()).toMatch(/^line \d+: /)
    await expect(source).toBeExisting()

    await clickPageSourceButton('Cancel')
    const discard = $('[role="alertdialog"]').$('button=Discard')
    await discard.waitForClickable({ timeout: ACTION_TIMEOUT })
    await discard.click()
    await source.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Discard did not close source mode',
    })

    await reopenTheNewPage()
    await expectAbsent(staticWith(EDITED), 'the text edit of the refused save')
    await openPageSource([MARKER])
    const text = await pageSourceText()
    expect(text).not.toContain(EDITED)
    expect(text).not.toContain('repeat::')
  })
})
