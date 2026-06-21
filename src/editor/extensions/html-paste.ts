/**
 * TipTap extension: convert pasted clipboard HTML to Agaric Markdown (#1439).
 *
 * Pasting from a web page (or another rich editor) carries a `text/html`
 * fragment on the clipboard. The browser's / ProseMirror's default paste either
 * drops the formatting or lands literal text. This handler intercepts the paste,
 * converts the HTML to Agaric's markdown subset, and inserts STRUCTURED content:
 *
 *   - single inline run (one heading/paragraph/list-item, no nesting) → inserted
 *     inline at the caret as real marks (bold/italic/code/strike/links);
 *   - multi-block (several blocks, or any nesting) → routed through the existing
 *     block-creation path: `dispatchBlockEvent('PASTE_HTML_BLOCKS', …)` →
 *     the focused BlockTree's `pasteBlocks(focusedBlockId, indentedMarkdown)`
 *     (`parseIndentedMarkdown`, `src/lib/block-clipboard.ts`).
 *
 * No regressions: when there is no USABLE `text/html` (absent, empty, or only a
 * bare wrapper) the handler returns `false` so the existing handlers
 * (`task-paste`, `external-link`) and the plain-text fallback run unchanged. It
 * MUST therefore be ordered BEFORE `TaskPaste` and `ExternalLink` in the editor
 * extension list (they share the same `handlePaste` chain).
 *
 * Bundle gate (#750): Turndown is loaded via dynamic `import()` INSIDE the
 * handler, so it stays out of the main chunk and only loads on the first HTML
 * paste.
 *
 * MVP scope: headings, paragraphs, lists (incl. nesting), links, and
 * bold/italic/code/strike marks. Tables, fenced code blocks, images,
 * blockquotes/callouts and task lists are deliberately left to a follow-up.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import { dispatchBlockEvent } from '@/lib/block-events'
import { logger } from '@/lib/logger'

import { parse } from '../markdown-serializer'
import type { DocNode } from '../types'

const htmlPastePluginKey = new PluginKey('htmlPaste')

/**
 * Decide whether a clipboard `text/html` payload is worth converting. Rejects
 * the absent / empty / wrapper-only cases so the handler can fall through to the
 * existing handlers + plain-text paste. Exported for testing.
 *
 * A payload is "usable" when, after stripping tags, it carries some visible text
 * AND it actually contains at least one HTML tag (a `text/html` that is really
 * just escaped plain text has no tags and is better handled by the plain-text
 * path). Browsers commonly wrap a copied fragment in
 * `<html><body><!--StartFragment-->…<!--EndFragment--></body></html>`, so the
 * wrapper alone (no inner text) is correctly rejected.
 */
export function isUsableHtml(html: string | undefined | null): html is string {
  if (!html) return false
  if (!/<[a-zA-Z][\s\S]*>/.test(html)) return false
  // Strip comments + tags, decode the few entities that matter for emptiness,
  // and check that some visible text remains.
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-zA-Z]+;/g, 'x')
    .trim()
  return text.length > 0
}

/**
 * Parse a clipboard HTML string into a `body` ParentNode using the platform
 * `DOMParser`. Returns null when parsing is unavailable or fails.
 */
function parseHtmlBody(html: string): ParentNode | null {
  if (typeof DOMParser === 'undefined') return null
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return doc.body
  } catch (err) {
    logger.warn('htmlPaste', 'DOMParser failed', undefined, err)
    return null
  }
}

/**
 * Perform the async HTML → blocks conversion and insert the result. Runs AFTER
 * the handler has already claimed the paste (preventDefault via returning true),
 * so on any failure we fall back to inserting the plain-text payload to avoid
 * silently dropping the user's content.
 */
async function convertAndInsert(view: EditorView, html: string, plainText: string): Promise<void> {
  try {
    // Lazy-load Turndown + the converter so they stay out of the main chunk and
    // only load on the first HTML paste (#750).
    const [{ createInlineTurndown }, { htmlBodyToOutline, outlineToIndentedMarkdown }] =
      await Promise.all([import('../inline-turndown'), import('../html-to-blocks')])

    const body = parseHtmlBody(html)
    if (!body) {
      insertPlainText(view, plainText)
      return
    }

    const { inline } = createInlineTurndown()
    const blocks = htmlBodyToOutline(body, inline)

    if (blocks.length === 0) {
      // Usable-looking HTML that yielded no blocks (e.g. only unsupported
      // elements). Fall back to the plain-text payload rather than nothing.
      insertPlainText(view, plainText)
      return
    }

    // Single, top-level, list-marker-free block → insert inline at the caret so
    // the marks land in the current block (no new block created). Lists and
    // headings always route through the block path so they become their own
    // typed blocks.
    if (blocks.length === 1 && blocks[0]?.depth === 0 && !isStructuralLine(blocks[0].content)) {
      insertInlineMarkdown(view, blocks[0].content)
      return
    }

    // Multi-block (or nested / heading / list) → materialize via the focused
    // BlockTree's `pasteBlocks`. Routed through the focus-keyed block command
    // bus so exactly the owning tree handles it.
    const markdown = outlineToIndentedMarkdown(blocks)
    dispatchBlockEvent('PASTE_HTML_BLOCKS', { markdown })
  } catch (err) {
    logger.warn('htmlPaste', 'conversion failed; falling back to plain text', undefined, err)
    insertPlainText(view, plainText)
  }
}

/**
 * A block line that must become its OWN typed block (heading / bullet / ordered
 * item), never inlined into the current paragraph.
 */
function isStructuralLine(content: string): boolean {
  return /^(#{1,6} |- |\d+\. )/.test(content)
}

/** Insert single-line markdown as inline PM content (marks) at the caret. */
function insertInlineMarkdown(view: EditorView, markdown: string): void {
  const doc = parse(markdown) as DocNode
  const inlineNodes = doc.content?.[0]?.content
  const { schema } = view.state
  if (!inlineNodes || inlineNodes.length === 0) {
    insertPlainText(view, markdown)
    return
  }
  try {
    const fragmentJson = { type: 'paragraph', content: inlineNodes }
    const pmNode = schema.nodeFromJSON(fragmentJson)
    const tr = view.state.tr.replaceSelectionWith(pmNode, false)
    view.dispatch(tr)
  } catch (err) {
    logger.warn('htmlPaste', 'inline insert failed; falling back to text', undefined, err)
    insertPlainText(view, markdown)
  }
}

/** Insert raw text at the caret (plain-text fallback). */
function insertPlainText(view: EditorView, text: string): void {
  if (text.length === 0) return
  view.dispatch(view.state.tr.insertText(text))
}

export const HtmlPaste = Extension.create({
  name: 'htmlPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: htmlPastePluginKey,
        props: {
          handlePaste: (view, event) => {
            const html = event.clipboardData?.getData('text/html')
            // No usable HTML → fall through to task-paste / external-link /
            // the default plain-text path unchanged (no regressions).
            if (!isUsableHtml(html)) return false

            const plainText = event.clipboardData?.getData('text/plain') ?? ''

            // Claim the paste synchronously (the conversion is async). The
            // async path inserts structured content, or the plain-text payload
            // on any failure, so content is never silently dropped.
            void convertAndInsert(view, html, plainText)
            return true
          },
        },
      }),
    ]
  },
})
