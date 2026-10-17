// ---------------------------------------------------------------------------
// Page mode (#5691) on the real backend: the Blocks | Page switch, the page as
// one document, and keys typed into it. The document is read from the DOM:
// each block is a `[data-page-block]` carrying its id and depth.
//
// Globals (`$`, `$$`, `browser`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { ACTION_TIMEOUT, NAV_TIMEOUT, distinctKeyChunks } from './helpers'

export const PAGE_MODE = '[data-testid="page-mode-editor"]'

/** Choose `name` on the page header's Blocks | Page switch, and wait for that mode to show. */
export async function chooseEditMode(name: 'Blocks' | 'Page'): Promise<void> {
  const radio = async () => {
    for (const item of await $$(
      '[role="radiogroup"][aria-label="Editing mode"] [role="radio"]',
    ).getElements()) {
      if ((await item.getText()) === name) return item
    }
    throw new Error(`the Editing mode switch has no ${name}`)
  }
  await browser.waitUntil(async () => (await radio().catch(() => null)) !== null, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: 'the page header never showed the Editing mode switch',
  })
  if ((await (await radio()).getAttribute('aria-checked')) !== 'true') await (await radio()).click()
  await browser.waitUntil(
    async () => (await (await radio()).getAttribute('aria-checked')) === 'true',
    {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `${name} never became the page's editing mode`,
    },
  )
  if (name === 'Page') await $(PAGE_MODE).waitForDisplayed({ timeout: NAV_TIMEOUT })
  else await $('[data-testid="sortable-block"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

export interface PageModeBlock {
  id: string
  depth: number
  text: string
}

/** The page-mode document as shown. */
export function pageModeBlocks(): Promise<PageModeBlock[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(`${selector} [data-page-block]`)].map((el) => ({
        id: el.getAttribute('data-page-block-id') ?? '',
        depth: Number(el.getAttribute('data-depth')),
        text: el.textContent ?? '',
      })),
    PAGE_MODE,
  )
}

/** The index of the block whose text holds `marker`. */
export async function pageModeIndexOf(marker: string): Promise<number> {
  const index = (await pageModeBlocks()).findIndex((block) => block.text.includes(marker))
  if (index === -1) throw new Error(`no page-mode block holds ${marker}`)
  return index
}

/**
 * Put the cursor `offset` characters into block `index`'s text (or at its end),
 * through the editor TipTap keeps on its element: a click lands where layout
 * puts it, and WebKitGTK moves a native caret late.
 */
export async function pageModeCaret(index: number, offset: number | 'end'): Promise<void> {
  await browser.execute(
    (selector: string, at: number, into: number | 'end') => {
      const dom = document.querySelector<
        HTMLElement & {
          editor?: {
            state: {
              doc: {
                child: (i: number) => {
                  nodeSize: number
                  firstChild: { content: { size: number } }
                }
              }
            }
            commands: { setTextSelection: (pos: number) => boolean }
            view: { focus: () => void }
          }
        }
      >(selector)
      if (dom?.editor === undefined) throw new Error('pageModeCaret: no page-mode editor')
      const { doc } = dom.editor.state
      let pos = 0
      for (let i = 0; i < at; i += 1) pos += doc.child(i).nodeSize
      const length = doc.child(at).firstChild.content.size
      dom.editor.commands.setTextSelection(pos + 2 + (into === 'end' ? length : into))
      dom.editor.view.focus()
    },
    PAGE_MODE,
    index,
    offset,
  )
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector: string) => document.activeElement === document.querySelector(selector),
        PAGE_MODE,
      ),
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'the page-mode editor never took focus' },
  )
}

/**
 * Type `text` at the cursor, in runs with no repeated key (WebKitGTK drops a
 * key pressed again while held, see `distinctKeyChunks`), and wait for block
 * `index` to read `expected`. Throws with what it read instead of retrying.
 */
export async function typeInPageMode(text: string, index: number, expected: string): Promise<void> {
  for (const chunk of distinctKeyChunks(text)) {
    await browser.keys(Array.from(chunk))
  }
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = (await pageModeBlocks())[index]?.text ?? ''
        return seen === expected
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `page-mode block ${index} reads ${JSON.stringify(seen)}, not ${JSON.stringify(expected)}`,
      )
    })
}
