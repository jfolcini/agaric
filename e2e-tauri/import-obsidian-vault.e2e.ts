// ---------------------------------------------------------------------------
// Real-backend import of an Obsidian vault (#5740).
//
// A vault is a folder pick: each note imports as the page `<vault>/<note>`,
// shipping the bytes of the attachments it embeds (`ingest_attachments` in
// commands/pages/markdown.rs) and the paths of the notes its `[[Name]]` links
// name, which the backend writes with those notes' titles
// (`rewrite_vault_wikilinks`). Only this lane holds the stored bytes, the
// resolved link and the materialized tag, so each is asserted after a
// navigation round-trip: the link chip opens the vault's note and no page of
// the bare name exists, `[[über]]` names `Über.md` (the backend folds note
// names in full Unicode, as the frontend does), the tag chip reads its name,
// the front-matter property is set, the embed renders from the stored bytes,
// the image is an attachment only, never a page, and `![[topic]]`, Obsidian's
// stored embed of a note, is an embed block showing the note. `![[topic#^step]]`
// embeds one block of a note imported AFTER the one that names it, whose `^step`
// marker leaves the block's text: only the folder's closing `link_import_anchors`
// call can link it, so it is the embed showing that block alone.
//
// WebKitWebDriver cannot pick a folder: Send Keys with a directory path hands
// the input the directory itself as one File, which fails to read. So the
// Obsidian input's FileList is set in the page, each File carrying the
// `webkitRelativePath` a folder picker gives it.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  expectImageRendered,
  navigateTo,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Pick the folder `vault` holding `files` in the Data tab's Obsidian input and
 * wait until the result region reads `summary`.
 */
async function importVault(
  vault: string,
  files: Record<string, Buffer>,
  summary: string,
): Promise<void> {
  await navigateTo('Settings')
  const dataTab = $('#settings-tab-data')
  await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
  await dataTab.click()
  await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
  await $('[data-testid="import-obsidian-input"]').waitForExist({ timeout: ACTION_TIMEOUT })
  const entries = Object.entries(files).map(([name, bytes]) => ({
    name,
    rel: `${vault}/${name}`,
    b64: bytes.toString('base64'),
  }))
  await browser.execute((list: Array<{ name: string; rel: string; b64: string }>) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="import-obsidian-input"]')
    if (input === null) throw new Error('no Obsidian import input')
    const picked = new DataTransfer()
    for (const { name, rel, b64 } of list) {
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name)
      Object.defineProperty(file, 'webkitRelativePath', { value: rel })
      picked.items.add(file)
    }
    input.files = picked.files
    if (input.files?.[0]?.webkitRelativePath !== list[0]?.rel) {
      throw new Error('the input lost the files or their relative paths')
    }
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, entries)
  const result = $('[data-testid="import-result"]')
  await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  let text = ''
  await browser
    .waitUntil(
      async () => {
        text = await result.getText()
        return text.includes(summary)
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `the import result reads ${JSON.stringify(text)}, not ${JSON.stringify(summary)}`,
      )
    })
}

/**
 * The Pages entry titled exactly `title`: a namespaced page is a leaf of the
 * namespace tree (PageTreeItem.tsx), a flat one a PageRow; both carry the
 * full title in the label span's `title` attribute.
 */
function pageEntry(title: string) {
  return $(`span[title="${title}"]`)
}

async function openPage(title: string): Promise<void> {
  await navigateTo('Pages')
  await pageEntry(title).waitForClickable({ timeout: NAV_TIMEOUT })
  await pageEntry(title).click()
  await expectPageOpen(title)
}

async function expectPageOpen(title: string): Promise<void> {
  await browser.waitUntil(async () => (await $('[aria-label="Page title"]').getText()) === title, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page ${title} never opened`,
  })
}

async function blockId(marker: string): Promise<string> {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const id = await block.getAttribute('data-block-id')
  if (id === null) throw new Error(`the block ${marker} has no data-block-id`)
  return id
}

describe('Agaric real-backend Obsidian vault import (#5740) @markdown', () => {
  it('imports a vault with its wikilink, tag, front matter, embedded image and note embeds', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-obs')
    const vault = `${marker}-vault`
    const home = `${marker}-home`
    const topic = `${marker}-topic`
    const homeMd = [
      '---',
      `reviewer: ${marker}-alice`,
      '---',
      `- ${marker}-links [[${topic}]] #${marker}-tag`,
      `- ${marker}-figure ![[pic.png]]`,
      `- ![[${topic}]]`,
      `- ![[${topic}#^step]]`,
      `- ${marker}-umlaut [[über]]`,
      '',
    ].join('\n')
    // The image is an attachment, so the pick makes three pages.
    await importVault(
      vault,
      {
        [`${home}.md`]: Buffer.from(homeMd),
        [`${topic}.md`]: Buffer.from(`- ${marker}-body\n- ${marker}-step ^step\n`),
        'Über.md': Buffer.from(`- ${marker}-uber\n`),
        'pic.png': PNG,
      },
      'Imported “3 files”',
    )

    await navigateTo('Journal')
    await navigateTo('Pages')
    await pageEntry(`${vault}/${topic}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`span[title="${topic}"]`, `a page titled ${topic}`)
    await pageEntry(`${vault}/Über`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent('span[title="über"]', 'a page titled über')
    await expectAbsent(`span[title="${vault}/pic.png"]`, 'a page made of the image')

    await openPage(`${vault}/${home}`)
    const links = await blockId(`${marker}-links`)
    const tag = $(`li[data-block-id="${links}"] [data-testid="tag-ref-chip"]`)
    await tag.waitForExist({ timeout: NAV_TIMEOUT })
    let tagText = ''
    await browser
      .waitUntil(
        async () => {
          tagText = await tag.getText()
          return tagText.includes(`${marker}-tag`)
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the tag chip reads ${JSON.stringify(tagText)}, not the imported tag`)
      })
    await expectImageRendered(await blockId(`${marker}-figure`), 'the embedded image')
    // The embeds in block order: the note, whose two blocks both show, then the
    // one block `^step` named, which shows alone.
    let embeds: string[] = []
    await browser
      .waitUntil(
        async () => {
          embeds = await browser.execute(() =>
            [...document.querySelectorAll('[data-testid="embed-container"]')].map(
              (embed) => embed.textContent ?? '',
            ),
          )
          const [note, block] = embeds
          return (
            note?.includes(`${marker}-body`) === true &&
            note.includes(`${marker}-step`) &&
            block?.includes(`${marker}-step`) === true &&
            !block.includes(`${marker}-body`)
          )
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(
          `the embeds read ${JSON.stringify(embeds)}, not the note and then its ^step block`,
        )
      })
    const umlaut = $(
      `li[data-block-id="${await blockId(`${marker}-umlaut`)}"] [data-testid="block-link-chip"]`,
    )
    await browser.waitUntil(async () => (await umlaut.getAttribute('title')) === `${vault}/Über`, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: '[[über]] never resolved to Über.md',
    })

    const properties = $('.page-property-table-header')
    await properties.waitForClickable({ timeout: NAV_TIMEOUT })
    await properties.click()
    const reviewer = $('[aria-label="reviewer value"]')
    await reviewer.waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await reviewer.getValue()).toBe(`${marker}-alice`)

    // The link names the vault's note, and opens it.
    const chip = $(`li[data-block-id="${links}"] [data-testid="block-link-chip"]`)
    await browser.waitUntil(
      async () => (await chip.getAttribute('title')) === `${vault}/${topic}`,
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the wikilink never resolved to the vault note it names',
      },
    )
    await chip.click()
    await expectPageOpen(`${vault}/${topic}`)
    await blockStaticByMarker(`${marker}-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })
})
