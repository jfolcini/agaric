// ---------------------------------------------------------------------------
// "Show Markdown syntax around the cursor" on the real backend (#5689).
//
// With the preference on, the roving editor draws `**` / `*` markers, a
// heading's `#` run and a link's `[` / `](url)` as widgets beside the caret.
// ProseMirror reads WebKitGTK's contenteditable DOM back into the document as
// the user types, so this WebView is where a marker could leak into what is
// saved. Type with the markers drawn, change a heading's level through its `#`
// run and a link's URL through its field, leave the view and come back: the
// stored blocks hold the formatting, the level and the URL, and no marker.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeInputVerified,
  typeVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-reveal')
const HEADING = runScopedMarker('wdio-level')
const LINKED = runScopedMarker('wdio-url')
const URL_FIELD = 'input[aria-label="Link URL"]'
const NEW_URL = 'https://example.org/new'
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const TYPED = `${MARKER} **bold** and *it* end`
const SHOWN = `${MARKER} bold and it end`

async function turnRevealOn(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-editor')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  const toggle = $('#reveal-markdown-toggle')
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  await browser.waitUntil(async () => (await toggle.getAttribute('aria-checked')) === 'true', {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the "Show Markdown syntax around the cursor" switch never turned on',
  })
}

/**
 * The editor's text with its bold, italic, heading level and links written
 * back as Markdown, so `typeVerified` can compare it with the keys typed.
 * Drawn markers are widgets, not text, so they are left out; a marker that
 * leaked into the text stays in.
 */
async function typedMarkdown(selector: string): Promise<string> {
  return browser.execute((sel: string) => {
    const copy = document.querySelector(sel)?.cloneNode(true) as HTMLElement | undefined
    if (!copy) return ''
    for (const marker of copy.querySelectorAll('[data-testid="md-reveal-marker"]')) marker.remove()
    for (const bold of copy.querySelectorAll('strong')) bold.textContent = `**${bold.textContent}**`
    for (const italic of copy.querySelectorAll('em')) italic.textContent = `*${italic.textContent}*`
    for (const link of copy.querySelectorAll('a')) {
      link.textContent = `[${link.textContent}](${link.getAttribute('href')})`
    }
    for (const heading of copy.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      heading.textContent = `${'#'.repeat(Number(heading.tagName.slice(1)))} ${heading.textContent}`
    }
    return copy.textContent ?? ''
  }, selector)
}

/** Put the caret `offset` characters into the text node that reads `text`, through the editor's own API. */
async function caretInto(text: string, offset: number): Promise<void> {
  await browser.execute(
    (sel: string, wanted: string, by: number) => {
      interface TextNode {
        isText: boolean
        text?: string
      }
      const el = document.querySelector(sel) as HTMLElement & {
        editor: {
          state: { doc: { descendants: (f: (node: TextNode, pos: number) => void) => void } }
          commands: { setTextSelection: (pos: number) => boolean }
        }
      }
      let at = -1
      el.editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText && node.text === wanted) at = pos + by
      })
      el.editor.commands.setTextSelection(at)
    },
    EDITOR,
    text,
    offset,
  )
}

async function focusedLabel(): Promise<string | null> {
  return browser.execute(() => document.activeElement?.getAttribute('aria-label') ?? null)
}

/** Put the caret inside the bold word, through the editor's own API. */
async function caretIntoBold(): Promise<void> {
  await browser.execute((sel: string) => {
    interface TextNode {
      isText: boolean
      text?: string
    }
    const el = document.querySelector(sel) as HTMLElement & {
      editor: {
        state: { doc: { descendants: (f: (node: TextNode, pos: number) => void) => void } }
        commands: { setTextSelection: (pos: number) => boolean }
      }
    }
    let inside = -1
    el.editor.state.doc.descendants((node, pos) => {
      if (inside < 0 && node.isText && node.text === 'bold') inside = pos + 2
    })
    el.editor.commands.setTextSelection(inside)
  }, EDITOR)
}

describe('Markdown syntax revealed around the cursor on the real backend (#5689)', () => {
  it('saves bold and italic typed with the markers drawn, and no marker', async () => {
    await waitForAppReady()
    await turnRevealOn()
    await navigateTo('Journal')

    await openJournalBlockEditor()
    await typeVerified(EDITOR, TYPED, typedMarkdown, 'block editor')
    const editor = $(EDITOR)
    await expect(editor.$('strong')).toHaveText('bold')
    await expect(editor.$('em')).toHaveText('it')

    // The preference is live in this WebView: the caret in the bold word draws its markers.
    await caretIntoBold()
    await browser.waitUntil(
      async () => (await $$('[data-testid="md-reveal-marker"]').getElements()).length === 2,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the caret in bold text drew no Markdown markers' },
    )
    await browser.keys(['Escape'])

    await navigateTo('Pages')
    await navigateTo('Journal')
    const stored = blockStaticByMarker(MARKER)
    await stored.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(stored).toHaveText(SHOWN)
    await expect(stored.$('strong')).toHaveText('bold')
    await expect(stored.$('em')).toHaveText('it')
  })

  it('saves a heading level changed through its # run and a URL set in its field', async () => {
    await waitForAppReady()
    await turnRevealOn()
    await navigateTo('Journal')

    // `## HEADING heading`, then left of its `#` run, where `#` raises it to level 3.
    await openJournalBlockEditor()
    await typeVerified(EDITOR, `## ${HEADING} heading`, typedMarkdown, 'block editor')
    await $(EDITOR).$('h2').waitForExist({ timeout: ACTION_TIMEOUT })
    await caretInto(`${HEADING} heading`, 0)
    await browser.keys(['ArrowLeft'])
    await browser.keys(['#'])
    await $(EDITOR).$('h3').waitForExist({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: '# typed left of the heading’s # run did not raise it to level 3',
    })
    await browser.keys(['Escape'])

    // A link, then ArrowRight at the end of its label into the URL field.
    await openJournalBlockEditor()
    await typeVerified(
      EDITOR,
      `${LINKED} see [label](https://example.com) end`,
      typedMarkdown,
      'block editor',
    )
    await caretInto('label', 5)
    await browser.keys(['ArrowRight'])
    await browser.waitUntil(async () => (await focusedLabel()) === 'Link URL', {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'ArrowRight at the end of the label did not move into the URL field',
    })
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeInputVerified(URL_FIELD, NEW_URL)
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await $(EDITOR).$('a').getAttribute('href')) === NEW_URL, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Enter in the URL field did not set the link’s URL',
    })
    await browser.keys(['Escape'])

    await navigateTo('Pages')
    await navigateTo('Journal')
    const heading = blockStaticByMarker(HEADING)
    await heading.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(heading.$('h3')).toHaveText(`${HEADING} heading`)
    const linked = blockStaticByMarker(LINKED)
    await linked.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(linked.$('[data-testid="external-link"]')).toHaveAttribute('data-href', NEW_URL)
  })
})
