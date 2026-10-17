// ---------------------------------------------------------------------------
// "Show Markdown syntax around the cursor" on the real backend (#5689).
//
// With the preference on, the roving editor draws `**` / `*` markers as widgets
// beside the caret's mark. ProseMirror reads WebKitGTK's contenteditable DOM
// back into the document as the user types, so this WebView is where a marker
// could leak into what is saved. Type bold and italic text through the input
// rules with the markers drawn, leave the view and come back: the stored block
// holds the formatted text and no marker.
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
  typeVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-reveal')
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
 * The editor's text with its bold and italic written back as Markdown, so
 * `typeVerified` can compare it with the keys typed. Drawn markers are widgets,
 * not text, so they are left out; a marker that leaked into the text stays in.
 */
async function typedMarkdown(selector: string): Promise<string> {
  return browser.execute((sel: string) => {
    const copy = document.querySelector(sel)?.cloneNode(true) as HTMLElement | undefined
    if (!copy) return ''
    for (const marker of copy.querySelectorAll('[data-testid="md-reveal-marker"]')) marker.remove()
    for (const bold of copy.querySelectorAll('strong')) bold.textContent = `**${bold.textContent}**`
    for (const italic of copy.querySelectorAll('em')) italic.textContent = `*${italic.textContent}*`
    return copy.textContent ?? ''
  }, selector)
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
})
