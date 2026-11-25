// ---------------------------------------------------------------------------
// Real-backend editor durability (#5733): an audio attachment plays from its
// stored bytes, typing commits on an idle pause without a blur, and a draft
// brings back what a killed app never committed.
//
// - A pasted `.wav` is a block attachment (`add_attachment_with_bytes`), not
//   an inline ref; StaticBlock's attachment section renders it as an
//   `<audio controls>` whose `src` is a `blob:` URL of `read_attachment`'s
//   bytes. A player that decodes the WAV's length proves the bytes on disk,
//   which the mock never holds.
// - `useDebouncedContentCommit` sends `edit_block` 700 ms after the last
//   keystroke while the editor keeps focus (#2600). The op is read through
//   `get_block_history`, because opening History would blur the editor.
// - `useDraftAutosave` writes `block_drafts` 2 s after the last keystroke, and
//   boot (`recover_at_boot`, then the frontend's `flush_all_drafts`) turns a
//   leftover row into an `edit_block`. The idle commit already saves plain
//   text, so the draft is the sole copy only of an edit that commit leaves to
//   blur, such as a `#name` typed as text (`classifyUnmountFlush`). The spec
//   checks that precondition, then SIGKILLs the app (`restartApp('kill')`), so
//   no blur, unload or window close can save the text another way.
//
// - Page mode across a restart (#5691): text typed in page mode reaches the
//   backend through the block commands, under ids the client mints for new
//   blocks. The process ends and a new one opens the same vault, so nothing the
//   webview held survives; the blocks come back with their text, depth and ids,
//   the ids every `((ref))` and `[[link]]` points at.
// - A tag colour from the synced `color` property (#6544): picked in the Tags
//   view, it is written to localStorage and to the property. With localStorage
//   cleared after a restart, the colour can come only from the preload's re-read
//   of the property. The navigation round-trip is the bridge's:
//   `e2e/tag-management.spec.ts` "keeps a tag colour with localStorage cleared,
//   after leaving the view".
// - Op-log compaction across a restart (#6518): compaction is the one exception
//   to the append-only op log. The case ages every op past the retention window
//   by moving `op_log.created_at` back in `notes.db` (not in the op hash; the
//   update trigger lets it through only while the `_op_log_mutation_allowed`
//   sentinel is present, as compaction itself does), compacts through History's
//   "Remove old history" card, restarts, and reads the page back. The purge
//   also has to clamp the apply cursor down to the surviving log (#3310): a
//   cursor left above an emptied log is the state boot reports as corruption,
//   so the cursor is read from `notes.db` before the restart, whose boot would
//   heal it. It purges every case's history, so it runs last.
//
// Each case opens its own page, so the cases do not depend on each other's
// data; only the compaction depends on order.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  appVaultDir,
  blockStaticByMarker,
  confirmDialog,
  expectAbsent,
  invoke,
  navigateTo,
  openEditHistory,
  openNewPage,
  pasteFileIntoFocusedBlock,
  reopenPageByTitle,
  reopenPageHolding,
  restartApp,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import {
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

const AUDIO_PAGE = runScopedMarker('wdio-audio-page')
const AUDIO_BLOCK = runScopedMarker('wdio-audio-holder')
const AUDIO_FILE = 'wdio-voice.wav'

const COMMIT_PAGE = runScopedMarker('wdio-idle-commit-page')
const COMMIT_TEXT = runScopedMarker('wdio-idle-commit')

const DRAFT_PAGE = runScopedMarker('wdio-draft-page')
const DRAFT_TAG = runScopedMarker('wdio-draft-tag')
const DRAFT_TEXT = `${runScopedMarker('wdio-draft-text')} #${DRAFT_TAG}`

const PAGE_MODE_PAGE = runScopedMarker('wdio-page-mode-page')
const PAGE_MODE_FIRST = runScopedMarker('wdio-page-mode-first')
const PAGE_MODE_SECOND = runScopedMarker('wdio-page-mode-second')

const COLOUR_TAG = runScopedMarker('wdio-tag-colour')
const ROSE = 'var(--accent-rose, var(--accent-current))'
const tagItem = `[data-testid="tag-item-${COLOUR_TAG}"]`

const COMPACTION_PAGE = runScopedMarker('wdio-compaction-page')
const COMPACTION_MARKER = runScopedMarker('wdio-compaction-block')
const LATER_PAGE = runScopedMarker('wdio-compaction-later-page')
const LATER = runScopedMarker('wdio-compaction-later-block')
/** Past `DEFAULT_RETENTION_DAYS` (90). */
const AGE_MS = 200 * 24 * 60 * 60 * 1000
const CARD = '.compaction-card'

const SAMPLE_RATE = 8000
const WAV_SECONDS = 0.1

/** A mono 8-bit PCM WAV of `WAV_SECONDS`: the 44-byte header and a tone. */
function tinyWav(): Buffer {
  const samples = Buffer.from(
    Array.from(
      { length: SAMPLE_RATE * WAV_SECONDS },
      (_, i) => 128 + Math.round(64 * Math.sin(i / 4)),
    ),
  )
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

/** The `to_text` of every `edit_block` op the backend holds for `blockId`. */
async function editedTexts(blockId: string): Promise<string[]> {
  const page = await invoke<{ items: Array<{ payload: string }> }>('get_block_history', {
    blockId,
    opTypeFilter: 'edit_block',
    cursor: null,
    limit: 50,
  })
  return page.items.map((op) => (JSON.parse(op.payload) as { to_text: string }).to_text)
}

/** The id of the block the roving editor is in, and whether the editor has focus. */
async function editorState(): Promise<{ id: string | null; focused: boolean }> {
  return await browser.execute((sel: string) => {
    const editor = document.querySelector(sel)
    return {
      id: editor?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
      focused: editor !== null && document.activeElement === editor,
    }
  }, EDITOR)
}

async function editorBlockId(): Promise<string> {
  const { id } = await editorState()
  if (id === null) throw new Error('no block editor is open')
  return id
}

/** What the one `<audio>` of block `id` holds: its source and the media it decoded. */
interface Player {
  players: number
  label?: string | null
  src?: string
  duration?: number
  mediaError?: number | null
}

/**
 * Wait until block `id` renders one audio player whose `blob:` source decoded
 * to `seconds` of audio. The CSP's `connect-src` keeps the blob from being
 * fetched back, so the decoded length stands in for the bytes: only the stored
 * WAV decodes to it.
 */
async function expectAudioPlays(id: string, seconds: number): Promise<void> {
  await $(`[data-block-id="${id}"]`).scrollIntoView()
  let seen: Player = { players: 0 }
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute((blockId: string) => {
          const players = [...document.querySelectorAll('audio')].filter(
            (audio) => audio.closest('[data-block-id]')?.getAttribute('data-block-id') === blockId,
          )
          const [only] = players
          if (players.length !== 1 || only === undefined) return { players: players.length }
          return {
            players: 1,
            label: only.getAttribute('aria-label'),
            src: only.getAttribute('src') ?? '',
            // NaN until decoded, and WebDriver cannot return a NaN.
            duration: Number.isFinite(only.duration) ? only.duration : -1,
            // Not `error`: wdio reads a returned `error` key as a WebDriver error.
            mediaError: only.error?.code ?? null,
          }
        }, id)
        return (
          seen.players === 1 &&
          seen.label === `Audio ${AUDIO_FILE}` &&
          seen.src?.startsWith('blob:') === true &&
          Math.abs((seen.duration ?? 0) - seconds) < 0.005
        )
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`block ${id} plays no ${seconds} s of audio: ${JSON.stringify(seen)}`)
    })
}

/** Wait until the tag's badge in the Tags view paints `expected` as its `--tag-color`. */
async function expectBadgeColour(expected: string, when: string): Promise<void> {
  await $(tagItem).waitForDisplayed({ timeout: NAV_TIMEOUT })
  let seen = ''
  await browser.waitUntil(
    async () => {
      seen = (await browser.execute(
        (selector: string) =>
          document
            .querySelector<HTMLElement>(`${selector} [data-slot="badge"]`)
            ?.style.getPropertyValue('--tag-color') ?? '',
        tagItem,
      )) as string
      return seen === expected
    },
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `${when}: the badge painted ${JSON.stringify(seen)}, not ${expected}`,
    },
  )
}

/** The History rows whose preview holds `marker`. */
function historyRows(marker: string): string {
  return (
    '//*[@data-history-item]' +
    `[.//*[contains(@class, "history-item-preview")][contains(normalize-space(.), "${marker}")]]`
  )
}

function openVault(readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path.join(appVaultDir(), 'notes.db'), { readOnly })
  // The running app holds the database; wait out its writer rather than fail.
  db.exec('PRAGMA busy_timeout = 10000')
  return db
}

/** Move every op past the retention window, so compaction removes them all. */
function ageEveryOp(): void {
  const db = openVault(false)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('INSERT INTO _op_log_mutation_allowed (token) VALUES (1)')
    db.prepare('UPDATE op_log SET created_at = created_at - ?').run(AGE_MS)
    db.exec('DELETE FROM _op_log_mutation_allowed')
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** The apply cursor and the newest locally-authored op it may not pass. */
function cursorAndFrontier(): { cursor: number; frontier: number } {
  const db = openVault(true)
  try {
    const row = db
      .prepare(
        'SELECT (SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1) AS cursor, ' +
          '(SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE is_replicated = 0) AS frontier',
      )
      .get() as { cursor: number; frontier: number }
    return { cursor: Number(row.cursor), frontier: Number(row.frontier) }
  } finally {
    db.close()
  }
}

async function cardNumber(testid: string): Promise<number> {
  const cell = $(`${CARD} [data-testid="${testid}"]`)
  await cell.waitForDisplayed({ timeout: NAV_TIMEOUT })
  return Number(await cell.getText())
}

describe('Agaric real-backend editor durability (#5733) @editor @pages @boot', () => {
  before(async () => {
    await waitForAppReady()
  })

  it('plays a pasted WAV inline from its stored bytes after leaving the page', async () => {
    const wav = tinyWav().toString('base64')
    await openNewPage(AUDIO_PAGE)
    await typeMarkerVerified(AUDIO_BLOCK)
    await pasteFileIntoFocusedBlock(wav, AUDIO_FILE, 'audio/wav')
    await waitForToast(`Attached "${AUDIO_FILE}"`)

    await navigateTo('Journal')
    await reopenPageByTitle(AUDIO_PAGE)
    const block = blockStaticByMarker(AUDIO_BLOCK)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await block.getAttribute('data-block-id')
    if (id === null) throw new Error('the audio block has no data-block-id')

    await expectAudioPlays(id, WAV_SECONDS)
  })

  it('commits typed text as an edit_block on an idle pause, with the editor still focused', async () => {
    await openNewPage(COMMIT_PAGE)
    const id = await editorBlockId()
    await typeMarkerVerified(COMMIT_TEXT)

    let texts: string[] = []
    await browser
      .waitUntil(
        async () => {
          texts = await editedTexts(id)
          return texts.includes(COMMIT_TEXT)
        },
        { timeout: ACTION_TIMEOUT, interval: 500 },
      )
      .catch(() => {
        throw new Error(
          `no edit_block of ${COMMIT_TEXT} while the editor kept focus; ops: ${JSON.stringify(texts)}`,
        )
      })
    expect(await editorState()).toEqual({ id, focused: true })
  })

  it('restores text typed into a block from its draft after the app is killed mid-edit', async () => {
    await openNewPage(DRAFT_PAGE)
    const id = await editorBlockId()
    await typeMarkerVerified(DRAFT_TEXT)

    let drafts: Array<{ block_id: string; content: string }> = []
    await browser
      .waitUntil(
        async () => {
          drafts = await invoke('list_drafts')
          return drafts.some((draft) => draft.block_id === id && draft.content === DRAFT_TEXT)
        },
        { timeout: ACTION_TIMEOUT, interval: 500 },
      )
      .catch(() => {
        throw new Error(`no draft of ${DRAFT_TEXT} was saved; drafts: ${JSON.stringify(drafts)}`)
      })
    // The draft is the only copy, or the restart below would prove nothing.
    expect((await editedTexts(id)).filter((text) => text.includes(DRAFT_TAG))).toEqual([])

    await restartApp('kill')
    await reopenPageByTitle(DRAFT_PAGE)
    let shown: string[] = []
    await browser
      .waitUntil(
        async () => {
          shown = await browser.execute(() =>
            [...document.querySelectorAll('[data-testid="block-static"]')].map(
              (row) => row.textContent ?? '',
            ),
          )
          return shown.some((text) => text.includes(DRAFT_TAG))
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(
          `the drafted text never came back after the restart; the page shows ${JSON.stringify(shown)}`,
        )
      })
  })

  it('keeps the text, depth and ids of blocks edited in page mode across a restart (#5691)', async () => {
    await openNewPage(PAGE_MODE_PAGE)
    // Typed in block mode: an empty first block would be the empty-block
    // cleanup's to delete as the switch takes focus.
    await typeMarkerVerified(PAGE_MODE_FIRST)
    await chooseEditMode('Page')

    // Edit the block page mode opened on, then split off a new one and indent it.
    await pageModeCaret(0, 'end')
    await typeInPageMode(' page', 0, `${PAGE_MODE_FIRST} page`)
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Enter never split off a second block',
    })
    await typeInPageMode(PAGE_MODE_SECOND, 1, PAGE_MODE_SECOND)
    await browser.keys(['Tab'])
    await browser.waitUntil(async () => (await pageModeBlocks())[1]?.depth === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Tab never moved the second block under the first',
    })
    const before = await pageModeBlocks()
    expect(before.map((block) => block.text)).toEqual([`${PAGE_MODE_FIRST} page`, PAGE_MODE_SECOND])
    // Switching back to blocks saves what page mode has not saved yet.
    await chooseEditMode('Blocks')

    await restartApp()
    await reopenPageByTitle(PAGE_MODE_PAGE)
    await chooseEditMode('Page')

    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'page mode never showed the two blocks after the restart',
    })
    expect(await pageModeBlocks()).toEqual(before)
    expect(await pageModeIndexOf(PAGE_MODE_SECOND)).toBe(1)
  })

  it('keeps a tag colour from its property after a restart with localStorage cleared (#6544)', async () => {
    await navigateTo('Tags')
    await typeInputVerified('[aria-label="New tag name"]', COLOUR_TAG)
    const addTag = $('button*=Add tag')
    await addTag.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addTag.click()
    await $(tagItem).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    const row = $(`//li[.//*[@data-testid="tag-item-${COLOUR_TAG}"]]`)
    await row.moveTo()
    await row.$('button[aria-label="Set tag color"]').click()
    const rose = $('[data-radix-popper-content-wrapper] button[aria-label="Rose"]')
    await rose.waitForClickable({ timeout: ACTION_TIMEOUT })
    await rose.click()
    await expectBadgeColour(ROSE, 'after picking rose')

    // Cleared on both sides of the restart, so boot cannot read the colour back from it either.
    await browser.execute(() => localStorage.removeItem('tag-colors'))
    await restartApp()
    await browser.execute(() => localStorage.removeItem('tag-colors'))
    await navigateTo('Tags')
    await expectBadgeColour(ROSE, 'after a restart with localStorage cleared')
  })

  it('compaction keeps the page, removes its history and leaves the apply cursor on the log (#6518)', async () => {
    await openNewPage(COMPACTION_PAGE)
    await typeMarkerVerified(COMPACTION_MARKER)
    await navigateTo('Journal')
    await reopenPageHolding(COMPACTION_PAGE, COMPACTION_MARKER)
    ageEveryOp()

    await openEditHistory()
    await $(historyRows(COMPACTION_MARKER)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'History never listed the op that wrote the marker',
    })
    const expand = $(`${CARD} button[aria-expanded="false"]`)
    await expand.waitForClickable({ timeout: ACTION_TIMEOUT })
    await expand.click()
    const total = await cardNumber('compaction-total-ops')
    const eligible = await cardNumber('compaction-eligible-ops')
    expect(total).toBeGreaterThan(0)
    // Every op is aged, so the purge takes the newest one too: the case the
    // cursor clamp exists for.
    expect(eligible).toBe(total)
    const compact = $(CARD).$('button=Compact now')
    await compact.waitForClickable({ timeout: ACTION_TIMEOUT })
    await compact.click()
    await confirmDialog('Compact')
    await waitForToast(`Compacted ${eligible} operation`)
    // The log is empty, so the cursor must be too.
    expect(cursorAndFrontier()).toEqual({ cursor: 0, frontier: 0 })

    await restartApp()
    await reopenPageHolding(COMPACTION_PAGE, COMPACTION_MARKER)
    // A write after the purge is the History row the absence check waits behind.
    await openNewPage(LATER_PAGE)
    await typeMarkerVerified(LATER)
    await navigateTo('Journal')
    await reopenPageHolding(LATER_PAGE, LATER)
    await openEditHistory()
    await $(historyRows(LATER)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'History never listed the op written after the compaction',
    })
    await expectAbsent(historyRows(COMPACTION_MARKER), 'the compacted op that wrote the marker')
  })
})
