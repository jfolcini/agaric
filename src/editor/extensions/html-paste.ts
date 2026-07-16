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
 * Scope: headings, paragraphs, lists (incl. nesting), links, and
 * bold/italic/code/strike marks (#1439 MVP); plus tables, fenced code blocks,
 * images, blockquotes/callouts and task lists (#1439 Phase 2). See
 * `html-to-blocks.ts` for the per-construct emission and the multi-line-block
 * (table / code fence) outline encoding.
 */

import { Extension } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import { parse } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import { dispatchBlockEvent } from '@/lib/block-events'
import { logger } from '@/lib/logger'
import { useBlockStore } from '@/stores/blocks'

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
  // Use the DOM to decide emptiness rather than regex tag-stripping: regex
  // sanitization of HTML is bypassable (CodeQL js/incomplete-multi-character-
  // sanitization), and the browser parser drops tags/comments correctly. A
  // `text/html` payload that is really just escaped plain text parses to a body
  // with no element children, so it is (correctly) rejected to the plain-text
  // path. Fall back to a presence *test* (not a replace) where DOMParser is
  // unavailable.
  if (typeof DOMParser === 'undefined') return /<[a-zA-Z][\s\S]*>/.test(html)
  let body: HTMLElement | null
  try {
    body = new DOMParser().parseFromString(html, 'text/html').body
  } catch {
    return false
  }
  if (!body || body.querySelector('*') === null) return false
  return (body.textContent ?? '').trim().length > 0
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
 *
 * The conversion is async (dynamic `import()` + DOM walk), and the single-block
 * roving editor view is unmounted on blur / navigation / Android suspend (#2033),
 * so the view may be DESTROYED by the time this resolves. Dispatching against a
 * destroyed view throws, so we early-return on `view.isDestroyed` before every
 * dispatch (mirroring the picker-plugin `editor.view?.isDestroyed` convention).
 *
 * `targetBlockId` is the focused block captured SYNCHRONOUSLY at paste time; it
 * is threaded into the `PASTE_HTML_BLOCKS` payload so the receiver can no-op when
 * focus has since moved to a different block, rather than routing structured
 * content into whatever block happens to be focused at resolution time (#2033).
 *
 * @internal Exported for testing.
 */
export async function convertAndInsert(
  view: EditorView,
  html: string,
  plainText: string,
  targetBlockId: string | null,
): Promise<void> {
  // The view may have been destroyed between claiming the paste and now.
  if (view.isDestroyed) return
  try {
    // Lazy-load Turndown + the converter so they stay out of the main chunk and
    // only load on the first HTML paste (#750).
    const [{ createInlineTurndown }, { htmlBodyToOutline, outlineToIndentedMarkdown }] =
      await Promise.all([import('@/editor/inline-turndown'), import('@/editor/html-to-blocks')])

    // The dynamic import is itself a turn, so re-check after it resolves.
    if (view.isDestroyed) return

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
      // #2454 — the single roving TipTap view can be handed to a DIFFERENT block
      // during the async conversion turn WITHOUT being destroyed (the view object
      // survives; only its document / active block changes), so `isDestroyed`
      // does not catch a focus handoff. The inline insert lands at the CURRENT
      // caret, so re-check that the focused block still matches the paste-time
      // `targetBlockId` before splicing marks; if focus has moved, abort rather
      // than corrupt whatever block is now focused. Mirrors the multi-block
      // receiver's guard (useBlockTreeEventListeners.ts) and the picker-handoff
      // precedent (#2428). `targetBlockId == null` keeps prior behaviour.
      if (targetBlockId != null && useBlockStore.getState().focusedBlockId !== targetBlockId) {
        logger.warn('htmlPaste', 'Discarding inline HTML paste: focus moved since paste', {
          targetBlockId,
          focusedBlockId: useBlockStore.getState().focusedBlockId,
        })
        return
      }
      insertInlineMarkdown(view, blocks[0].content)
      return
    }

    // Multi-block (or nested / heading / list) → materialize via the focused
    // BlockTree's `pasteBlocks`. Routed through the focus-keyed block command
    // bus so exactly the owning tree handles it. The captured `targetBlockId`
    // lets the receiver reject the paste if focus has since moved (#2033).
    const markdown = outlineToIndentedMarkdown(blocks)
    dispatchBlockEvent('PASTE_HTML_BLOCKS', { markdown, targetBlockId })
  } catch (err) {
    logger.warn('htmlPaste', 'conversion failed; falling back to plain text', undefined, err)
    insertPlainText(view, plainText)
  }
}

/**
 * A block that must become its OWN typed block, never inlined into the current
 * paragraph: a heading / bullet / ordered item / task (#1439), or — Phase 2 —
 * a multi-line construct (table, fenced code block; they carry a `\n`) or a
 * block-level table / code-fence / blockquote / image leader. Inlining any of
 * these would corrupt them, so they always route through the block-paste path.
 */
function isStructuralLine(content: string): boolean {
  // Multi-line content is always a standalone block (table / code fence).
  if (content.includes('\n')) return true
  return /^(#{1,6} |- |\d+\. |[-*] \[[ xX/-]\]|\||```|>|!\[)/.test(content)
}

/** Insert single-line markdown as inline PM content (marks) at the caret. */
function insertInlineMarkdown(view: EditorView, markdown: string): void {
  // The view may have been destroyed while the conversion was in flight (#2033);
  // dispatching against a destroyed view throws.
  if (view.isDestroyed) return
  const doc = parse(markdown) as DocNode
  const inlineNodes = doc.content?.[0]?.content
  const { schema } = view.state
  if (!inlineNodes || inlineNodes.length === 0) {
    insertPlainText(view, markdown)
    return
  }
  try {
    // Splice the INLINE nodes into the current textblock as an open slice.
    // Wrapping them in a paragraph NODE (replaceSelectionWith) would split the
    // parent textblock in three instead of inserting at the caret.
    const fragment = Fragment.from(inlineNodes.map((node) => schema.nodeFromJSON(node)))
    const tr = view.state.tr.replaceSelection(new Slice(fragment, 0, 0))
    view.dispatch(tr)
  } catch (err) {
    logger.warn('htmlPaste', 'inline insert failed; falling back to text', undefined, err)
    insertPlainText(view, markdown)
  }
}

/** Insert raw text at the caret (plain-text fallback). */
function insertPlainText(view: EditorView, text: string): void {
  if (text.length === 0) return
  // Guard every dispatch path: this is also the catch-path / no-blocks fallback,
  // which can run after the view was destroyed mid-conversion (#2033).
  if (view.isDestroyed) return
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
            // Inside a code textblock the paste must stay literal: let
            // ProseMirror's default code-context paste insert the text/plain
            // payload into the fence (guard convention: math.ts, query-hint.ts).
            if (view.state.selection.$from.parent.type.spec.code) return false

            const html = event.clipboardData?.getData('text/html')
            // No usable HTML → fall through to task-paste / external-link /
            // the default plain-text path unchanged (no regressions).
            if (!isUsableHtml(html)) return false

            const plainText = event.clipboardData?.getData('text/plain') ?? ''

            // Capture the focused (paste-target) block id SYNCHRONOUSLY: the
            // conversion is async, so by the time multi-block content is routed
            // through the bus the focus may have moved. Threading the captured
            // id lets the receiver reject a paste into the wrong block (#2033).
            const targetBlockId = useBlockStore.getState().focusedBlockId

            // Claim the paste synchronously (the conversion is async). The
            // async path inserts structured content, or the plain-text payload
            // on any failure, so content is never silently dropped.
            void convertAndInsert(view, html, plainText, targetBlockId)
            return true
          },
        },
      }),
    ]
  },
})
