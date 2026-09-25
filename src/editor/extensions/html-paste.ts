/**
 * TipTap extension: convert pasted clipboard HTML to Agaric Markdown (#1439),
 * and route pasted markdown text to the block-paste path (#5140, #5160 D4).
 *
 * Pasting from a web page (or another rich editor) carries a `text/html`
 * fragment on the clipboard. The browser's / ProseMirror's default paste either
 * drops the formatting or lands literal text. This handler intercepts the paste,
 * converts the HTML to Agaric's markdown subset, and inserts STRUCTURED content:
 *
 *   - single inline run (one heading/paragraph/list-item, no nesting) → inserted
 *     inline at the caret as real marks (bold/italic/code/strike/links);
 *   - multi-block (several blocks, or any nesting) → routed through the
 *     block-creation path: `dispatchBlockEvent('PASTE_BLOCKS', …)` → the
 *     focused BlockTree's `pasteBlocks(focusedBlockId, { kind: 'blocks', … })`.
 *
 * With no usable HTML, plain text of more than one line — or one bullet line,
 * our own copy of a block — takes the same route as `{ kind: 'text', … }`, so
 * the backend reads it with the import grammar instead of ProseMirror escaping
 * its markers into literal paragraphs. A single line stays inline, and a lone
 * task line stays with `TaskPaste`.
 *
 * Both routes splice like a text editor (#5160 D4): the payload carries the
 * block's text before and after the selection, so the first pasted block joins
 * the block at the cursor, a selection is replaced, and the text after the
 * cursor ends the last block. It also carries the block as a plain-text paste
 * would leave it, for the toast's "Paste as text". Ctrl/Cmd+Shift+V pastes the
 * text as literal lines, directly; browsers send only `text/plain` for it, so
 * the chord is read on keydown.
 *
 * No regressions: any other paste without USABLE `text/html` (absent, empty, or
 * only a bare wrapper) returns `false` so the existing handlers (`task-paste`,
 * `external-link`) and the plain-text fallback run unchanged. It
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
 * `html-to-blocks.ts` for the per-construct emission.
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import { pastedTaskParagraph } from '@/editor/extensions/task-paste'
import { notifyUnknownNodeTypeToast } from '@/editor/markdown-serialize-toast'
import { parse, serialize } from '@/editor/markdown-serializer'
import type { DocNode } from '@/editor/types'
import type { PasteInput, PasteSplice } from '@/lib/bindings'
import { dispatchBlockEvent } from '@/lib/block-events'
import { logger } from '@/lib/logger'
import { useBlockStore } from '@/stores/blocks'

/**
 * The `PASTE_BLOCKS` payload: what to paste, into which block, where in its
 * text, and the block as a plain-text paste would leave it (`asText`, for the
 * toast's "Paste as text").
 */
export interface PasteBlocksDetail {
  input: PasteInput
  targetBlockId: string | null
  splice: PasteSplice
  asText: string
}

const htmlPastePluginKey = new PluginKey('htmlPaste')

/**
 * Parse a clipboard HTML string and return its `body` iff it is "usable" —
 * after stripping tags it carries some visible text AND it actually contains
 * at least one HTML tag (a `text/html` that is really just escaped plain
 * text has no element children and is better handled by the plain-text
 * path). Browsers commonly wrap a copied fragment in
 * `<html><body><!--StartFragment-->…<!--EndFragment--></body></html>`, so the
 * wrapper alone (no inner text) is correctly rejected. Returns `null` when
 * unusable, unavailable (no `DOMParser`), or parsing throws.
 *
 * #3277 — the single parse point for the whole paste path: `handlePaste`
 * calls this ONCE to both decide usability and obtain the `body` it threads
 * into `convertAndInsert`, instead of the old two-parse split (a boolean
 * `isUsableHtml` gate, then a second, independent `parseHtmlBody` inside the
 * async conversion) that DOM-parsed the identical clipboard string twice —
 * the blocking half (the gate) on the main thread before `handlePaste` could
 * even return.
 *
 * A `null` return IS `handlePaste`'s "not usable" answer — the handler returns
 * false and the paste falls through to the plain-text path — so the usability
 * assertions belong here and nowhere else (#4008 note 2).
 *
 * DELIBERATELY NOT CARRIED OVER from the `isUsableHtml` boolean gate this
 * replaced (#4012 item 2): that function had a `/<[a-zA-Z][\s\S]*>/` regex
 * fallback for hosts with no `DOMParser`, answering "usable" from the raw
 * string. Here, no `DOMParser` means `null` — "not usable". The behavioural
 * difference is confined to such a host: the old path claimed the paste and
 * then landed the payload via `insertPlainText` (its own `parseHtmlBody`
 * returned null too, so conversion could never run); this one declines the
 * paste, and the browser's default handler runs instead. `DOMParser` is
 * universally available in every environment this app ships to, so the branch
 * is unreachable in production — which is exactly why the regex was dropped
 * rather than reimplemented: #3277 removed the gate's second, redundant parse,
 * and carrying the fallback forward would have re-pinned dead code (the six
 * assertions #4008 retargeted). The guard stays as a cheap total-function
 * contract, not as a supported mode.
 *
 * @internal Exported for testing.
 */
export function parseUsableHtmlBody(html: string): ParentNode | null {
  if (typeof DOMParser === 'undefined') return null
  let body: HTMLElement | null
  try {
    body = new DOMParser().parseFromString(html, 'text/html').body
  } catch (err) {
    logger.warn('htmlPaste', 'DOMParser failed', undefined, err)
    return null
  }
  if (!body || body.querySelector('*') === null) return null
  if ((body.textContent ?? '').trim().length === 0) return null
  return body
}

/**
 * Parse a clipboard HTML string into a `body` ParentNode using the platform
 * `DOMParser`. Returns null when parsing is unavailable or fails. Used only
 * by `convertAndInsert`'s fallback path (no precomputed body was supplied —
 * i.e. a caller other than `handlePaste`, such as a direct test call).
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
 * is threaded into the `PASTE_BLOCKS` payload so the receiver can no-op when
 * focus has since moved to a different block, rather than routing structured
 * content into whatever block happens to be focused at resolution time (#2033).
 *
 * `precomputedBody` — #3277: `handlePaste` already parses `html` once (via
 * `parseUsableHtmlBody`) to decide usability, so it passes that SAME parsed
 * `body` here to avoid a redundant second `DOMParser` pass over the identical
 * string. Omitted (the default), this falls back to parsing `html` itself —
 * every direct test call below relies on that fallback, unchanged.
 *
 * @internal Exported for testing.
 */
export async function convertAndInsert(
  view: EditorView,
  html: string,
  plainText: string,
  targetBlockId: string | null,
  precomputedBody?: ParentNode | null,
): Promise<void> {
  // The view may have been destroyed between claiming the paste and now.
  if (view.isDestroyed) return
  try {
    // Lazy-load Turndown + the converter so they stay out of the main chunk and
    // only load on the first HTML paste (#750).
    const [{ createInlineTurndown }, { htmlBodyToOutline }] = await Promise.all([
      import('@/editor/inline-turndown'),
      import('@/editor/html-to-blocks'),
    ])

    // The dynamic import is itself a turn, so re-check after it resolves.
    if (view.isDestroyed) return

    const body = precomputedBody !== undefined ? precomputedBody : parseHtmlBody(html)
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
    dispatchPasteBlocks(view, { kind: 'blocks', blocks }, plainText, targetBlockId)
  } catch (err) {
    logger.warn('htmlPaste', 'conversion failed; falling back to plain text', undefined, err)
    insertPlainText(view, plainText)
  }
}

/** A `- ` bullet line, or a bare `-`: the shape copy writes for one block. */
const BULLET_LINE_RE = /^[ \t]*-(?: |$)/

/**
 * Plain text to paste as blocks rather than into the editor (#5160 D4): more
 * than one non-blank line, or one bullet line, our own copy of one block. Any
 * other single line stays inline, a lone task line stays with `TaskPaste`, and
 * a lone `-` is just a dash.
 */
function isBlockPaste(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length > 1) return true
  const first = lines[0]
  if (first === undefined || !BULLET_LINE_RE.test(first) || first.trim() === '-') return false
  return pastedTaskParagraph(text) === null
}

/** Serialize a ProseMirror doc to the block's markdown. */
function toMarkdown(doc: PMNode): string {
  return serialize(doc.toJSON() as DocNode, notifyUnknownNodeTypeToast)
}

/** A wrapper the cut left with nothing inside: no textblock, no atom. */
function hollow(node: PMNode): boolean {
  if (node.isTextblock || node.isLeaf) return false
  let solid = false
  node.descendants((child) => {
    if (child.isTextblock || child.isLeaf) solid = true
    return !solid
  })
  return !solid
}

/**
 * The block's text before and after the selection (#5160 D4): the selected
 * range is in neither, so the paste replaces it. `after` ends the last pasted
 * block, so it is text alone: the tail of the selection's textblock as a plain
 * paragraph, then what follows that textblock. A plain `doc.cut` from the
 * caret would keep the textblock's type and its ancestors, so a heading, a
 * quote or a list item would repeat its marker mid-text.
 */
function pasteSplice(view: EditorView): PasteSplice {
  const { doc, selection, schema } = view.state
  const { $to } = selection
  const paragraph = schema.nodes['paragraph']
  let after = doc.cut(selection.to)
  if ($to.parent.isTextblock && paragraph) {
    let rest = doc.cut($to.after()).content
    while (rest.firstChild && hollow(rest.firstChild)) rest = rest.cut(rest.firstChild.nodeSize)
    const tail = paragraph.create(null, $to.parent.cut($to.parentOffset).content)
    after = doc.type.create(null, Fragment.from(tail).append(rest))
  }
  return { before: toMarkdown(doc.cut(0, selection.from)), after: toMarkdown(after) }
}

/**
 * The pasted text as literal lines: text nodes joined by hard breaks, with no
 * markdown read into them (trailing line breaks dropped).
 */
function literalLines(view: EditorView, text: string): Slice {
  const { schema } = view.state
  const hardBreak = schema.nodes['hardBreak']
  const nodes: PMNode[] = []
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  lines.forEach((line, index) => {
    if (index > 0 && hardBreak) nodes.push(hardBreak.create())
    if (line.length > 0) nodes.push(schema.text(line))
  })
  return new Slice(Fragment.from(nodes), 0, 0)
}

/** Paste `text` into the block as literal lines, replacing the selection. */
function insertLiteralLines(view: EditorView, text: string): void {
  if (view.isDestroyed) return
  view.dispatch(view.state.tr.replaceSelection(literalLines(view, text)))
}

/** Route `input` to the block-paste path, spliced at the selection. */
function dispatchPasteBlocks(
  view: EditorView,
  input: PasteInput,
  plainText: string,
  targetBlockId: string | null,
): void {
  const asText = toMarkdown(view.state.tr.replaceSelection(literalLines(view, plainText)).doc)
  const detail: PasteBlocksDetail = { input, targetBlockId, splice: pasteSplice(view), asText }
  dispatchBlockEvent('PASTE_BLOCKS', detail)
}

/** Ctrl/Cmd+Shift+V, the paste-as-plain-text chord. */
function isPlainPasteChord(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'v'
  )
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
    // Set by the Ctrl/Cmd+Shift+V keydown, read by the paste it fires; any
    // other key clears it.
    let plainPasteChord = false
    return [
      new Plugin({
        key: htmlPastePluginKey,
        props: {
          handleKeyDown: (_view, event) => {
            plainPasteChord = isPlainPasteChord(event)
            return false
          },
          handlePaste: (view, event) => {
            const plain = plainPasteChord
            plainPasteChord = false
            // Inside a code textblock the paste must stay literal: let
            // ProseMirror's default code-context paste insert the text/plain
            // payload into the fence (guard convention: math.ts, query-hint.ts).
            if (view.state.selection.$from.parent.type.spec.code) return false

            const plainText = event.clipboardData?.getData('text/plain') ?? ''
            if (plain && plainText.length > 0) {
              insertLiteralLines(view, plainText)
              return true
            }

            const html = event.clipboardData?.getData('text/html') ?? ''
            // #3277 — ONE parse decides usability AND supplies the body
            // `convertAndInsert` walks; the old `isUsableHtml` gate parsed
            // the same string again a second time inside the conversion.
            const body = html ? parseUsableHtmlBody(html) : null

            // Capture the focused (paste-target) block id SYNCHRONOUSLY: the
            // conversion is async, so by the time multi-block content is routed
            // through the bus the focus may have moved. Threading the captured
            // id lets the receiver reject a paste into the wrong block (#2033).
            const targetBlockId = useBlockStore.getState().focusedBlockId

            if (!body) {
              // No usable HTML → text worth reading as blocks goes to the
              // block-paste path; anything else falls through to task-paste /
              // external-link / the default plain-text path unchanged.
              if (!isBlockPaste(plainText)) return false
              dispatchPasteBlocks(view, { kind: 'text', text: plainText }, plainText, targetBlockId)
              return true
            }

            // Claim the paste synchronously (the conversion is async). The
            // async path inserts structured content, or the plain-text payload
            // on any failure, so content is never silently dropped.
            void convertAndInsert(view, html, plainText, targetBlockId, body)
            return true
          },
        },
      }),
    ]
  },
})
