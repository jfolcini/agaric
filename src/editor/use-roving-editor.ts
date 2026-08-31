/**
 * Roving TipTap editor — exactly ONE instance at all times.
 *
 * Mount on focus (parse → setContent). Unmount on blur (serialize →
 * compare → flush if dirty). Undo history is scoped per mount session
 * via addToHistory:false on content replacement transactions.
 */

import type { Content } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import History from '@tiptap/extension-history'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Italic from '@tiptap/extension-italic'
// BulletList is sourced from `@tiptap/extension-list` (the standalone
// `@tiptap/extension-bullet-list` is just a re-export shim and is not a direct
// dependency here, whereas `extension-list` is already installed — it is what
// `@tiptap/extension-ordered-list` itself re-exports). Mirrors OrderedList.
import { BulletList } from '@tiptap/extension-list'
import ListItem from '@tiptap/extension-list-item'
import OrderedList from '@tiptap/extension-ordered-list'
import Placeholder from '@tiptap/extension-placeholder'
import Strike from '@tiptap/extension-strike'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model'
import { type Editor, Extension, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { computeContentDelta, shouldSplitOnBlur } from '@/editor/content-delta'
import type { ContentDelta } from '@/editor/content-delta'
import { AtTagPicker, atTagPickerPluginKey } from '@/editor/extensions/at-tag-picker'
import { BlockLink } from '@/editor/extensions/block-link'
import { BlockLinkPicker, blockLinkPickerPluginKey } from '@/editor/extensions/block-link-picker'
import { BlockRef } from '@/editor/extensions/block-ref'
import { BlockRefPicker, blockRefPickerPluginKey } from '@/editor/extensions/block-ref-picker'
import { CalloutBlockquote } from '@/editor/extensions/callout-blockquote'
import { CheckboxInputRule } from '@/editor/extensions/checkbox-input-rule'
import { EmojiPicker, emojiPickerPluginKey } from '@/editor/extensions/emoji-picker'
import { ExternalLink } from '@/editor/extensions/external-link'
import { HtmlPaste } from '@/editor/extensions/html-paste'
import { Image } from '@/editor/extensions/image'
import {
  ListMarkerDecoration,
  setListMarkerMeta,
  type ListMarkerState,
} from '@/editor/extensions/list-marker-decoration'
import { MathBlock, MathInline } from '@/editor/extensions/math'
import { MermaidCodeBlockView } from '@/editor/extensions/MermaidCodeBlockView'
import { PropertyPicker, propertyPickerPluginKey } from '@/editor/extensions/property-picker'
import { QueryHint } from '@/editor/extensions/query-hint'
import { QueryPicker, queryPickerPluginKey } from '@/editor/extensions/query-picker'
import { SlashCommand, slashCommandPluginKey } from '@/editor/extensions/slash-command'
import { TagRef } from '@/editor/extensions/tag-ref'
import { TaskParagraph } from '@/editor/extensions/task-paragraph'
import { TaskPaste } from '@/editor/extensions/task-paste'
import { Underline } from '@/editor/extensions/underline'
import { notifyUnknownNodeTypeToast } from '@/editor/markdown-serialize-toast'
import { parse, serialize } from '@/editor/markdown-serializer'
import { ignoreReactNodeViewChrome } from '@/editor/node-view-mutations'
import { cleanupOrphanedPopups } from '@/editor/suggestion-renderer'
import type { PickerItem } from '@/editor/SuggestionList'
import { toggleCodeBlockSafely } from '@/editor/toggle-code-block-safely'
import type { DocNode } from '@/editor/types'
import { dispatchBlockEvent } from '@/lib/block-events'
import { unresolvedBlockLabel, unresolvedBlockRefLabel } from '@/lib/block-title'
import { tipTapShortcutMap } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { curatedLowlight } from '@/lib/lowlight-curated'

const suggestionPluginKeys = [
  atTagPickerPluginKey,
  blockLinkPickerPluginKey,
  blockRefPickerPluginKey,
  emojiPickerPluginKey,
  propertyPickerPluginKey,
  queryPickerPluginKey,
  slashCommandPluginKey,
]

// -- Pure content-delta helpers (moved to a TipTap-free module, #2939) ---------
// `computeContentDelta` / `shouldSplitOnBlur` / `ContentDelta` now live in
// `content-delta.ts` so the render-path modules (`EditableBlock`,
// `useEditorBlur`) can import them WITHOUT statically pulling this file's full
// TipTap extension graph onto the cold-start path. Re-exported here so the
// existing `use-roving-editor.test.ts` suite keeps importing them from this
// module unchanged.
export { computeContentDelta, shouldSplitOnBlur }
/**
 * @public Re-exported so this module's surface stays unchanged; no in-repo
 * caller names this type directly today (call sites consume
 * `computeContentDelta`'s return value structurally), but removing it would
 * silently narrow the facade this file's own comment above promises to keep.
 */
export type { ContentDelta }

// Share the curated lowlight instance with `RichContentRenderer` so bundlers
// only ship one copy of the grammars (see `src/lib/lowlight-curated.ts`).
const lowlight = curatedLowlight

// #726 — `editorProps` and the initial `content` are STATIC. They were inline
// object literals inside the `useEditor({...})` call, so each render produced
// fresh identities. `@tiptap/react`'s `useEditor` (empty-deps path) diffs the
// supplied options against the live editor's via `compareOptions`, which does a
// reference check (`a[key] !== b[key]`) on `content` and `editorProps`. Fresh
// literals therefore failed the diff every render → `setOptions` + view churn on
// every BlockTree render, independent of the extensions array. Hoisting both to
// module-level constants gives them stable identities so the diff short-circuits.
const EDITOR_PROPS = {
  attributes: {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'Block editor',
    // #925 — deliberate soft-keyboard configuration for the prose-first
    // block editor (previously unset, so mobile keyboards guessed). Enter
    // creates a new block, so hint the keyboard's action key as "enter";
    // notes are prose, so capitalize sentences and enable autocorrect /
    // spellcheck. `inputmode: text` keeps the standard text keyboard.
    enterkeyhint: 'enter',
    autocapitalize: 'sentences',
    autocorrect: 'on',
    spellcheck: 'true',
    inputmode: 'text',
  },
} as const

const INITIAL_CONTENT: Content = { type: 'doc', content: [{ type: 'paragraph' }] }

// ── Configurable formatting shortcuts ────────────────────────────────────
// NOTE (#752): the bindings below are FROZEN at editor creation. TipTap
// builds its keymap exactly once from `addKeyboardShortcuts()`, so
// `getShortcutKeys(...)` is read a single time when the Editor instance is
// constructed. A Settings rebind therefore only applies to editors created
// afterwards (in practice: after an app reload) — unlike the document-level
// listeners that route through `matchesShortcutBinding` on every keydown
// and pick rebinds up live. This freeze is pinned by the
// "shortcut bindings are frozen at editor creation (#752)" test in
// `__tests__/use-roving-editor.test.ts`; if live rebinding is ever wanted
// here, the extensions must dispatch through a `handleKeyDown` plugin prop
// instead of a static keymap.

/** Inline Code with configurable shortcut to toggle inline code. @internal Exported for testing. */
export const CodeWithShortcut = Code.extend({
  addKeyboardShortcuts() {
    return tipTapShortcutMap('inlineCode', () => this.editor.commands.toggleCode())
  },
})

/** Strike with configurable shortcut to toggle strikethrough. @internal Exported for testing. */
export const StrikeWithShortcut = Strike.extend({
  addKeyboardShortcuts() {
    return tipTapShortcutMap('strikethrough', () => this.editor.commands.toggleStrike())
  },
})

/** Highlight with configurable shortcut to toggle highlight. @internal Exported for testing. */
export const HighlightWithShortcut = Highlight.extend({
  addKeyboardShortcuts() {
    return tipTapShortcutMap('highlight', () => this.editor.commands.toggleHighlight())
  },
})

/**
 * Heading with its own default keyboard shortcuts stripped. @internal Exported for testing.
 *
 * #2679 — `@tiptap/extension-heading` ships hardcoded `Mod-Alt-1`…`Mod-Alt-6`
 * bindings (`toggleHeading`) baked into its own `addKeyboardShortcuts()`,
 * registered as a ProseMirror keymap directly on the editor DOM. When the
 * catalog's `heading1`-`heading6` defaults moved from `Ctrl+1`-`Ctrl+6` to
 * `Ctrl+Alt+1`-`Ctrl+Alt+6` (to stop colliding with `switchSpace1`-`switchSpace6`),
 * that chord became IDENTICAL to this stock TipTap binding. ProseMirror's
 * keymap plugin only calls `preventDefault()`, not `stopPropagation()` (see
 * `prosemirror-view`'s `editHandlers.keydown`), so the keydown still bubbles to
 * `document` afterward — where `useBlockTreeKeyboardShortcuts`'s own
 * `heading{level}` handler (routed through `matchesShortcutBinding`, so it
 * honors a live Settings rebind) ALSO matches and calls `handleSlashCommand`,
 * which converts the block via a completely separate markdown-text path
 * (`applyContentEdit`). Left alone, a single Ctrl+Alt+1 would fire BOTH
 * mechanisms back-to-back on the same keystroke. Stripping TipTap's own
 * shortcuts here (rather than wrapping them with `tipTapShortcutMap`, like
 * `CodeWithShortcut`/`StrikeWithShortcut`/`HighlightWithShortcut` do) keeps
 * headings on the single, live-rebindable `useBlockTreeKeyboardShortcuts`
 * path they already used before this collision existed — `tipTapShortcutMap`
 * bindings are frozen at editor-creation time (see the NOTE above), which
 * would silently regress "rebind heading1 in Settings" for existing editors.
 */
export const HeadingWithoutDefaultShortcuts = Heading.extend({
  addKeyboardShortcuts() {
    return {}
  },
})

/**
 * `name → value` for every attribute on `el`. Used to snapshot what a spec
 * render produced, so a later sync can tell the node view's OWN attributes
 * apart from whatever else has since written to the live element (#4356).
 */
function attributeMap(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of el.getAttributeNames()) out[name] = el.getAttribute(name) ?? ''
  return out
}

/** Split a `class` attribute value into its tokens (`''`/`undefined` → none). */
function classTokens(value: string | undefined): string[] {
  return value ? value.split(/\s+/).filter(Boolean) : []
}

/**
 * Move `el`'s `class` from the token set `prev` to the token set `next`,
 * touching nothing else. `class` on a node view's outer element is shared with
 * prosemirror-view (`ProseMirror-selectednode`, node-decoration classes), which
 * adds and removes single tokens; a whole-attribute write would drop them.
 */
function patchClassTokens(el: Element, prev: string | undefined, next: string | undefined): void {
  if (prev === next) return
  const prevTokens = classTokens(prev)
  const nextTokens = classTokens(next)
  for (const token of prevTokens) if (!nextTokens.includes(token)) el.classList.remove(token)
  for (const token of nextTokens) if (!prevTokens.includes(token)) el.classList.add(token)
  // `classList.remove` leaves `class=""` behind where the spec render would
  // have emitted no attribute at all; drop it so the live DOM still matches
  // what `getHTML()` serializes (the `class: null` parity #4316 pinned).
  //
  // This fires unconditionally, so it can't distinguish that case from a spec
  // that legitimately renders `class: ''` (as opposed to `class: null`): the
  // live `<pre>` would lose the attribute while `renderSpec` still emits
  // `class=""`, the same live-vs-`getHTML()` divergence this line exists to
  // prevent, just in the other direction. Only reachable on a non-empty→empty
  // transition, no in-tree writer produces `''` today, and the sibling sweep
  // in `syncContentAttributes` (which sets any non-`null` value, `class=""`
  // included) would disagree with this one if it ever became reachable. Not
  // fixed here — the right fix direction isn't obvious and it's unreachable.
  if (el.getAttribute('class') === '') el.removeAttribute('class')
}

// Reused across every `styleProperties` call instead of allocating a fresh
// `<div>` each time: it is never attached to the document (so it never
// affects layout/paint or is observable from outside this module), and each
// call immediately overwrites `cssText` in full before reading it back — no
// state survives between calls for a second caller to see.
const styleProbe = document.createElement('div')

/** The CSS property names set by a `style` attribute value. */
function styleProperties(value: string | undefined): string[] {
  if (!value) return []
  styleProbe.style.cssText = value
  return Array.from(styleProbe.style)
}

/**
 * The `style` counterpart of {@link patchClassTokens}: prosemirror-view appends
 * decoration styles onto the same element's `cssText`, so the sync is per
 * PROPERTY — drop the properties the previous spec render set and no longer
 * does, then write the current ones.
 */
function patchStyleProperties(
  el: HTMLElement,
  prev: string | undefined,
  next: string | undefined,
): void {
  if (prev === next) return
  const nextProps = styleProperties(next)
  for (const prop of styleProperties(prev)) {
    if (!nextProps.includes(prop)) el.style.removeProperty(prop)
  }
  if (next) el.style.cssText += `;${next}`
  // Same unconditional cleanup as `patchClassTokens`, with the same latent
  // hole: a spec legitimately rendering `style: ''` (vs. `style: null`) would
  // lose the attribute here while `renderSpec` still emits `style=""`. Only
  // reachable on a non-empty→empty transition, no in-tree writer produces
  // `''` today. Left as-is — see the comment in `patchClassTokens`.
  if (el.getAttribute('style') === '') el.removeAttribute('style')
}

/** CodeBlockLowlight with configurable shortcut to toggle code blocks. @internal Exported for testing. */
export const CodeBlockWithShortcut = CodeBlockLowlight.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      ...tipTapShortcutMap('codeBlock', () => {
        toggleCodeBlockSafely(this.editor as Editor)
        return true
      }),
    }
  },
  // #1438 — render a code block via a React node view. For language `mermaid`
  // it shows the rendered diagram (reusing MermaidDiagram) with a raw-source
  // toggle. The block is still a plain `codeBlock(language=mermaid)`, so it
  // round-trips to a ```mermaid fence via the existing markdown serializer.
  //
  // ONLY mermaid gets the React node view. Routing every language through it
  // froze the editor permanently on mobile: a React node view rewrites its own
  // subtree on re-render, prosemirror-view records those mutations and flushes,
  // the flush re-renders the node view, and the cycle never terminates. Any code
  // block — typed as ```␣, inserted from the slash menu, or picked in the
  // language selector — locked the app until it was killed.
  //
  // The UA gate is @tiptap/core's default `NodeView.ignoreMutation` (#4315
  // located it): on iOS/Android with the editor focused, a childList mutation
  // ANYWHERE inside the node view's `dom` is *not* ignored as long as every
  // added/removed node is contentEditable — so React's own writes are read back
  // as user edits. Desktop skips that branch and ignores everything outside
  // `contentDOM`, which is why desktop never spun. Mermaid keeps its React node
  // view and overrides `ignoreMutation` to the desktop rule (see below).
  //
  // Non-mermaid therefore uses a plain DOM node view, built from the node SPEC
  // rather than hand-copied from `renderHTML` (#4316 — see `renderFromSpec`).
  // Lowlight's highlighting is applied as decorations inside `contentDOM` and is
  // unaffected.
  addNodeView() {
    const nodeType = this.type
    const isMermaid = (node: PMNode): boolean => node.attrs['language'] === 'mermaid'

    // `spec.toDOM` IS the compiled `renderHTML`: tiptap sets
    // `schema.toDOM = node => renderHTML({ node, HTMLAttributes: getRenderedAttributes(…) })`
    // when it builds the schema, so it carries the extension's configured
    // `HTMLAttributes` AND every `addGlobalAttributes` rule that targets
    // `codeBlock`. Deriving the node view's DOM from it is what keeps the
    // on-screen DOM from drifting away from serialized HTML (copy/paste, export)
    // when either of those grows an entry. A missing `toDOM` would mean the
    // extension lost its `renderHTML` entirely — fail loudly at editor creation
    // rather than silently render a different `<pre>` than we serialize.
    const toDOM = nodeType.spec.toDOM
    if (!toDOM) throw new Error('codeBlock node spec has no toDOM — renderHTML is missing')

    /**
     * Render `node` through the spec. Returns the fresh `<pre>` and the `<code>`
     * content hole inside it.
     */
    const renderFromSpec = (node: PMNode): { dom: HTMLElement; contentDOM: HTMLElement } => {
      const rendered = DOMSerializer.renderSpec(
        document,
        toDOM(node),
        null,
        // #4357 — `blockArraysIn`. `prosemirror-model@1.25.11` declares
        // `renderSpec(doc, structure, xmlNS?)` in its `.d.ts` but implements a
        // FOURTH parameter, and its own `serializeNodeInner` passes `node.attrs`
        // there to arm the guard that rejects an attribute value being reused as
        // a DOM spec ("Using an array from an attribute object as a DOM spec…" —
        // the XSS defence). Without it this node view would render the same spec
        // with the guard DISARMED while copy/paste and export render it armed.
        // The directive is deliberately narrow and self-removing: when upstream
        // fixes the declaration, `@ts-expect-error` becomes unused and fails the
        // build, which is the signal to delete these lines.
        // @ts-expect-error — upstream .d.ts omits the implemented 4th parameter
        node.attrs,
      )
      const { contentDOM } = rendered
      if (!contentDOM) throw new Error('codeBlock renderHTML produced no content hole')
      return { dom: rendered.dom as HTMLElement, contentDOM }
    }

    // The mirror image of the plain view's `update` below: tiptap's default
    // `NodeView.update` only refuses when the node TYPE changes, and switching
    // `language` off `mermaid` is an attribute-only change on the SAME type.
    // Without this guard the React view survived mermaid→javascript and then
    // re-rendered into MermaidCodeBlockView's non-mermaid branch — a React node
    // view around a `<pre><code>`, i.e. exactly the DOMObserver flush loop this
    // whole node view exists to avoid. Returning false makes prosemirror
    // destroy it and rebuild the plain DOM view.
    const renderReact = ReactNodeViewRenderer(MermaidCodeBlockView, {
      update: ({ oldNode, newNode, updateProps }) => {
        if (!isMermaid(newNode)) return false
        // Mirror the default's `nodeChanged` short-circuit. Supplying `update`
        // REPLACES tiptap's own body, and that body re-renders the React
        // component only when the node identity actually changed. Calling
        // `updateProps()` unconditionally re-renders on every transaction
        // (selection moves, decoration changes), each render rewrites the
        // contentDOM, and the DOMObserver flushes it straight back — the same
        // never-terminating cycle, just confined to mermaid blocks.
        if (oldNode !== newNode) updateProps()
        return true
      },
      // #4315 — mermaid is the one language still on a React node view, i.e.
      // still in the configuration that froze the app, and measurement (see
      // `e2e/mobile-editor.spec.ts`) showed it DID freeze: the block never
      // materialised and React bailed out with "Maximum update depth exceeded".
      //
      // #4353 — the mechanism, the reason it is user-agent-gated, and the reason
      // a LEAF React node view (image, math) is not exposed to it all live in
      // `node-view-mutations.ts`. `codeBlock` is the only NON-leaf React node
      // view in the app, so it is the only one for which this option is even
      // consulted — tiptap answers a leaf view `true` before reading it.
      ignoreMutation: ignoreReactNodeViewChrome,
    })

    return (props) => {
      if (isMermaid(props.node)) return renderReact(props)

      const { dom, contentDOM } = renderFromSpec(props.node)

      // `update()` re-derives attributes from the same spec instead of
      // re-rendering into the live tree: `renderSpec` builds a FRESH element
      // tree (a `createElement` per tag plus a `setAttribute` loop — cheap, but
      // new objects), and a node view may not swap its `dom` or `contentDOM`
      // after mount without discarding the ProseMirror-managed children and the
      // selection inside them. So the throwaway render is used as the source of
      // truth for attributes only.
      const syncContentAttributes = (fresh: HTMLElement): void => {
        for (const name of contentDOM.getAttributeNames()) {
          if (!fresh.hasAttribute(name)) contentDOM.removeAttribute(name)
        }
        for (const name of fresh.getAttributeNames()) {
          const value = fresh.getAttribute(name)
          if (value !== null && contentDOM.getAttribute(name) !== value) {
            contentDOM.setAttribute(name, value)
          }
        }
      }

      // #4356 — the outer `<pre>` needs the same treatment as the content hole,
      // but it CANNOT be swept the way `contentDOM` is: after mount the `<pre>`
      // is shared. prosemirror-view writes its own attributes there (node
      // decorations via `patchOuterDeco`, `ProseMirror-selectednode` via
      // `selectNode`), so "remove everything the spec did not produce" would
      // delete them. What this node view owns is exactly the set of names the
      // SPEC produced, which is why the sweep below is driven by
      // `specAttrs` — the previous spec render's attributes — rather than by
      // the live element.
      //
      // `specAttrs` rolls forward on every sync rather than being frozen at
      // mount: an attribute the spec only starts producing on a later render
      // (a global attribute that renders nothing while its node attr is null)
      // must become removable too, and a name the spec just produced is by
      // construction not one of prosemirror-view's.
      //
      // NOT a name allowlist alone, which is what a first reading suggests.
      // `class` and `style` are SHARED namespaces, not owned attributes:
      // prosemirror-view merges into them token-wise (`classList.add/remove`,
      // `style.cssText +=`) and, once decorations stop changing,
      // `updateOuterDeco` short-circuits and never re-applies them — so a
      // blanket `setAttribute('class', …)` here would silently drop
      // `ProseMirror-selectednode` and every decoration class with no second
      // chance to restore them. Both are therefore diffed at the token /
      // property level, spec-render against spec-render, exactly as
      // prosemirror-view diffs its own: whatever this node view put there last
      // time is removed, whatever the spec produces now is added, and anything
      // another writer contributed is left alone.
      //
      // The one case that is NOT left alone is a token/property BOTH writers
      // contributed — neither side refcounts, so the spec dropping `foo` removes
      // the `foo` a decoration also wanted. prosemirror-view's `patchAttributes`
      // has the identical hole in the other direction; sharing a namespace
      // without a refcount cannot do better, and no writer here shares a name.
      let specAttrs = attributeMap(dom)
      const syncOuterAttributes = (fresh: HTMLElement): void => {
        const next = attributeMap(fresh)
        for (const [name, value] of Object.entries(next)) {
          if (name === 'class' || name === 'style') continue
          if (dom.getAttribute(name) !== value) dom.setAttribute(name, value)
        }
        for (const name of Object.keys(specAttrs)) {
          if (name === 'class' || name === 'style') continue
          // `Object.hasOwn`, not `name in next`: `next` is an ordinary object
          // keyed by extension-supplied attribute NAMES, and `in` walks the
          // prototype chain — so a `<pre constructor="…">` the spec has STOPPED
          // producing reads as still-produced (`'constructor' in {}` is true)
          // and is never removed, which is the exact staleness this sync exists
          // to fix. (prosemirror-view's own `patchAttributes` uses `in` here and
          // has the same hole.)
          if (!Object.hasOwn(next, name)) dom.removeAttribute(name)
        }
        patchClassTokens(dom, specAttrs['class'], next['class'])
        patchStyleProperties(dom, specAttrs['style'], next['style'])
        specAttrs = next
      }

      return {
        dom,
        contentDOM,
        update: (node) => {
          // A switch to/from mermaid needs the other node view: refuse the
          // update so prosemirror rebuilds this one.
          if (node.type !== props.node.type || isMermaid(node)) return false
          // One render serves both syncs: `contentDOM` is the content hole
          // INSIDE `dom` from this same `renderFromSpec` call, and both
          // helpers only read attribute names/values off the fresh tree —
          // neither mutates it — so there's nothing for a second render to
          // provide that this one doesn't already have.
          const fresh = renderFromSpec(node)
          syncContentAttributes(fresh.contentDOM)
          syncOuterAttributes(fresh.dom)
          return true
        },
      }
    }
  },
})

/** Dispatch a priority custom event on document. Exported for testing. */
export function dispatchPriorityEvent(level: 1 | 2 | 3): void {
  // Route through the typed helper so the event name is the single-source-of-
  // truth constant, not a hand-built literal (the producer/consumer can no
  // longer silently desync on a rename). `SET_PRIORITY_${level}` is a typed key
  // of BLOCK_EVENTS, so a typo here is a compile error.
  dispatchBlockEvent(`SET_PRIORITY_${level}`)
}

/** Custom extension dispatching priority shortcut events. @internal Exported for testing. */
export const PriorityShortcuts = Extension.create({
  name: 'priorityShortcuts',
  addKeyboardShortcuts() {
    return {
      ...tipTapShortcutMap('priority1', () => {
        dispatchPriorityEvent(1)
        return true
      }),
      ...tipTapShortcutMap('priority2', () => {
        dispatchPriorityEvent(2)
        return true
      }),
      ...tipTapShortcutMap('priority3', () => {
        dispatchPriorityEvent(3)
        return true
      }),
    }
  },
})

export interface RovingEditorOptions {
  /** Resolve tag ULID → display name */
  resolveTagName?: (id: string) => string
  /** Resolve block/page ULID → display title */
  resolveBlockTitle?: (id: string) => string
  /** Placeholder text for empty blocks */
  placeholder?: string
  /** Return tags matching query (for # picker). */
  searchTags?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Return pages matching query (for [[ picker). */
  searchPages?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Create a new page with the given title. Returns the new block's ULID. */
  onCreatePage?: (label: string) => Promise<string>
  /** Create a new tag with the given name. Returns the new tag's ULID. */
  onCreateTag?: (name: string) => Promise<string>
  /** Called when user clicks a [[block link]] chip to navigate. */
  onNavigate?: (id: string) => void
  /** Called when user clicks an #[ULID] tag chip to navigate. */
  onTagClick?: (id: string) => void
  /** Return slash commands matching query (for / picker). */
  searchSlashCommands?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Execute a selected slash command. */
  onSlashCommand?: (item: PickerItem) => void
  /** Called when checkbox syntax (- [ ] or - [x]) is detected during typing. */
  onCheckbox?: ((state: 'TODO' | 'DONE') => void) | null
  /** Return property keys matching query (for :: picker). */
  searchPropertyKeys?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Called when a property is selected from the :: picker. */
  onPropertySelect?: (item: PickerItem) => void
  /** Return blocks matching query (for (( picker). */
  searchBlockRefs?: (query: string) => PickerItem[] | Promise<PickerItem[]>
  /** Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

/** Options for {@link RovingEditorHandle.mount}. */
export interface MountOptions {
  /**
   * Where to place the caret after the mount focuses the editor.
   * `'end'` → end of the document (e.g. Backspace-delete landing in the
   * previous block); `'start'` → start. Omitted → TipTap's default focus
   * behaviour (restore previous selection / document start).
   */
  cursorPlacement?: 'start' | 'end' | undefined
}

export interface RovingEditorHandle {
  /** The TipTap editor instance (null before first mount). */
  editor: Editor | null
  /**
   * Mount the editor into a block. Parses markdown → PM doc → setContent.
   * Undo history is reset — Ctrl+Z never crosses the mount boundary.
   * `opts.cursorPlacement` positions the caret after focus (#752).
   */
  mount: (blockId: string, markdown: string, opts?: MountOptions) => void
  /**
   * #3000 — set the focused block's list marker (bullet / computed ordinal, or
   * `none`). No-op when the editor is unmounted. Called by the focused
   * `EditableBlock` on mount and whenever its listStyle/ordinal changes, so the
   * in-editor marker matches the read-only `StaticBlock` marker. The marker is
   * a decoration outside the document, so it never affects serialized content.
   */
  updateListMarker: (style: ListMarkerState['style'], ordinal: number | undefined) => void
  /**
   * Unmount the editor. Serializes PM doc → markdown. Returns the new
   * markdown string if content changed, or null if unchanged.
   */
  unmount: () => string | null
  /** The block ID currently being edited, or null. */
  activeBlockId: string | null
  /**
   * Read the current editor content as markdown WITHOUT unmounting.
   * Returns null if the editor is not mounted.
   */
  getMarkdown: () => string | null
  /**
   * Split the document at the collapsed caret (#909). Returns the markdown
   * before and after the caret, or null when the editor is unmounted or the
   * selection is a non-collapsed range. Does NOT mutate the document.
   */
  splitAtCaret: () => { before: string; after: string } | null
  /** The markdown string that was passed to `mount()`. */
  originalMarkdown: string
  /**
   * Register a callback invoked on every TipTap `update` event while the editor
   * is mounted, as a pure change SIGNAL (no arguments). Pass `null` to
   * unregister. #2938 — the callback receives NO serialized markdown: it only
   * signals that the document changed so consumers can (re)arm their debounce
   * timers and serialize the live editor on demand at fire time (via
   * `getMarkdown()`), instead of paying a per-keystroke serialize + React
   * commit.
   */
  setOnUpdate: (cb: (() => void) | null) => void
  /**
   * #2600 — rebase the "original markdown" baseline to `markdown` WITHOUT
   * unmounting. After a mid-typing debounced commit persists the current
   * content as an `edit_block` op, the caller marks it committed so a
   * subsequent blur `unmount()` (and the next debounce tick) compute their
   * delta against the freshly-committed text instead of the mount-time text —
   * otherwise blur would re-commit the whole block, doubling the op and the
   * undo entry. No-op when the editor is unmounted (`activeBlockId === null`).
   */
  markCommitted: (markdown: string) => void
}

/**
 * Replace the editor document without adding to undo history.
 * This ensures Ctrl+Z never crosses mount/unmount boundaries.
 * @internal Exported for testing.
 */
export function replaceDocSilently(editor: Editor, json: Record<string, unknown>): void {
  const pmDoc = editor.schema.nodeFromJSON(json)
  const { tr } = editor.state
  tr.replaceWith(0, editor.state.doc.content.size, pmDoc.content)
  tr.setMeta('addToHistory', false)
  editor.view.dispatch(tr)
}

export function useRovingEditor(options: RovingEditorOptions = {}): RovingEditorHandle {
  const {
    resolveTagName = (id: string) => `#${id.slice(0, 8)}...`,
    // #4551 — was a local `[[id…]]` literal duplicating `unresolvedBlockLabel`;
    // now the same helper every real resolver's own miss-fallback calls, so
    // this default and the app's resolvers can't drift on the shape.
    resolveBlockTitle = (id: string) => unresolvedBlockLabel(id),
    // / #544: callers own the placeholder text and pass the
    // i18n-keyed translation (e.g. BlockTree → t('block.emptyPlaceholder')).
    // The default is empty rather than a hardcoded English string so a caller
    // that forgets to pass it shows no hint instead of bypassing i18n.
    placeholder = '',
    searchTags = () => [],
    searchPages = () => [],
    onCreatePage,
    onCreateTag,
    onNavigate,
    onTagClick,
    searchSlashCommands = () => [],
    onSlashCommand,
    onCheckbox,
    searchPropertyKeys = () => [],
    onPropertySelect,
  } = options

  const activeBlockIdRef = useRef<string | null>(null)
  const originalMarkdownRef = useRef<string>('')
  // #2938 — a pure change SIGNAL fired on every TipTap `update` while mounted.
  // It carries NO serialized markdown: serializing per keystroke (previously
  // once per animation frame) is the typing-latency tax this issue removes.
  // Consumers (draft-autosave, content-commit) merely (re)arm their debounce
  // timers here and serialize the live editor ON DEMAND at fire/flush time.
  const onUpdateRef = useRef<(() => void) | null>(null)

  // Refs to hold latest callbacks — extensions capture these at creation
  // time but the refs always point to the current versions, preventing
  // stale closures inside NodeViews.
  const resolveTagNameRef = useRef(resolveTagName)
  // #921 — the placeholder is computed live per focused block (template hint vs
  // slash-command hint) but the editor is created once, so a captured string
  // froze at creation. Keep it in a ref and read it via Placeholder's function
  // form so the decoration reflects the CURRENT placeholder on every commit.
  const placeholderRef = useRef(placeholder)
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  const onNavigateRef = useRef(onNavigate)
  const onTagClickRef = useRef(onTagClick)
  const onCreatePageRef = useRef(onCreatePage)
  const onCreateTagRef = useRef(onCreateTag)
  const onSlashCommandRef = useRef(onSlashCommand)
  const onPropertySelectRef = useRef(onPropertySelect)
  const onCheckboxRef = useRef(onCheckbox)
  const searchBlockRefsRef = useRef(options.searchBlockRefs ?? (async () => [] as PickerItem[]))
  const searchTagsRef = useRef(searchTags)
  const searchPagesRef = useRef(searchPages)
  const searchSlashCommandsRef = useRef(searchSlashCommands)
  const searchPropertyKeysRef = useRef(searchPropertyKeys)
  // Written in a dependency-array-less layout effect (not during render): the
  // mirrors refresh on EVERY commit, before paint and before any passive effect
  // or user event, so the extension closures below always read current values.
  useLayoutEffect(() => {
    resolveTagNameRef.current = resolveTagName
    placeholderRef.current = placeholder
    resolveBlockTitleRef.current = resolveBlockTitle
    onNavigateRef.current = onNavigate
    onTagClickRef.current = onTagClick
    onCreatePageRef.current = onCreatePage
    onCreateTagRef.current = onCreateTag
    onSlashCommandRef.current = onSlashCommand
    onPropertySelectRef.current = onPropertySelect
    onCheckboxRef.current = onCheckbox
    searchBlockRefsRef.current = options.searchBlockRefs ?? (async () => [] as PickerItem[])
    searchTagsRef.current = searchTags
    searchPagesRef.current = searchPages
    searchSlashCommandsRef.current = searchSlashCommands
    searchPropertyKeysRef.current = searchPropertyKeys
  })

  // #726 — build the extensions array EXACTLY ONCE and keep its identity stable
  // across renders. `@tiptap/react`'s `useEditor` (called below with the default
  // empty deps array) takes the `deps.length === 0` path: on every render it
  // diffs the supplied options against the live editor's via `compareOptions`,
  // which compares the extensions array element-by-element by reference. A fresh
  // array of fresh `.configure()` instances each render therefore failed the
  // diff unconditionally → `setOptions` + `view.updateState` churned on EVERY
  // BlockTree render. This file is plain `.ts` (no JSX), so the React Compiler —
  // which only transforms `.tsx`/`.jsx` — does NOT auto-memoize it; the churn is
  // genuine. Every configured option already reads from a ref (`*.current`), so
  // the instances have no reactive inputs and an empty dep list is correct: the
  // placeholder, callbacks and resolvers all stay live via their refs.
  const extensions = useMemo(
    () => [
      Document,
      // #1481 — Paragraph carrying the GFM task `todoState` attr so parsed
      // checkbox state survives `nodeFromJSON` (the stock Paragraph drops it).
      TaskParagraph,
      Text,
      Bold,
      Italic,
      CodeWithShortcut,
      StrikeWithShortcut,
      HighlightWithShortcut,
      Underline,
      CalloutBlockquote,
      OrderedList,
      // #1436 — bullet/unordered lists. Shares `ListItem` with OrderedList and
      // provides the `- ` / `* ` input rules (TipTap's BulletList default).
      BulletList,
      ListItem,
      // #3000 — paints the focused block's list marker (bullet / computed
      // ordinal) as a widget decoration, fed via `updateListMarker`.
      ListMarkerDecoration,
      HorizontalRule,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockWithShortcut.configure({ lowlight }),
      HeadingWithoutDefaultShortcuts.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      HardBreak,
      History,
      // #1439 — convert pasted clipboard HTML to Agaric markdown. MUST precede
      // ExternalLink and TaskPaste in the handlePaste chain: it only claims the
      // paste when there is usable `text/html`, otherwise returns false so those
      // handlers (and the plain-text fallback) run unchanged.
      HtmlPaste,
      ExternalLink,
      // #1437 — KaTeX math: inline `$…$` and block `$$…$$` atoms (lazy KaTeX).
      MathInline,
      MathBlock,
      // #1434 — markdown `![alt](url)` image (inline atom, broken-image fallback).
      Image,
      PriorityShortcuts,
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `placeholderRef` supplies the empty-state placeholder text; see #4406
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `resolveTagNameRef` resolves a `#tag`'s display name and `onTagClickRef` fires on click; see #4406
      TagRef.configure({
        resolveName: (id: string) => resolveTagNameRef.current(id),
        onClick: (id: string) => onTagClickRef.current?.(id),
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `resolveBlockTitleRef` resolves the linked page's title and `onNavigateRef` fires on click; see #4406
      BlockLink.configure({
        resolveTitle: (id: string) => resolveBlockTitleRef.current(id),
        onNavigate: (id: string) => onNavigateRef.current?.(id),
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `resolveBlockTitleRef` resolves the embedded block's rendered content and `onNavigateRef` fires on click; see #4406
      BlockRef.configure({
        // #4551 — `resolveBlockTitleRef.current` is the SAME `resolveBlockTitle`
        // `BlockLink.configure` above hands to `renderBlockLink`'s NodeView
        // sibling, so a resolver's own "nothing resolved for this id" miss
        // fallback comes back `unresolvedBlockLabel`-shaped (`[[id…]]`,
        // PAGE-link shaped) even for a `((ULID))` block ref. Mirrors
        // `renderBlockRef`'s by-value substitution
        // (`@/components/RichContentRenderer/marks/blockRef.tsx`) so the
        // editing surface and the read-only renderer show the same `(( id… ))`
        // shape for the same broken ref instead of disagreeing on click.
        resolveContent: (id: string) => {
          const resolved = resolveBlockTitleRef.current(id)
          return resolved === unresolvedBlockLabel(id) ? unresolvedBlockRefLabel(id) : resolved
        },
        onNavigate: (id: string) => onNavigateRef.current?.(id),
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `searchTagsRef` powers the `@`-tag picker's query and `onCreateTagRef` creates a tag on demand; see #4406
      AtTagPicker.configure({
        items: (query: string) => searchTagsRef.current(query),
        onCreate: (name: string) => {
          const fn = onCreateTagRef.current
          if (!fn) return Promise.reject(new Error('onCreateTag not provided'))
          return fn(name)
        },
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `searchPagesRef` powers the `[[`-page picker's query and `onCreatePageRef` creates a page on demand; see #4406
      BlockLinkPicker.configure({
        items: (query: string) => searchPagesRef.current(query),
        onCreate: (label: string) => {
          const fn = onCreatePageRef.current
          if (!fn) return Promise.reject(new Error('onCreatePage not provided'))
          return fn(label)
        },
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `searchBlockRefsRef` powers the `((`-block-ref picker's query; see #4406
      BlockRefPicker.configure({
        items: (query: string) => searchBlockRefsRef.current(query),
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `searchSlashCommandsRef` powers the `/`-menu's query and `onSlashCommandRef` fires on selection; see #4406
      SlashCommand.configure({
        items: (query: string) => searchSlashCommandsRef.current(query),
        onCommand: (item: PickerItem) => onSlashCommandRef.current?.(item),
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `searchPropertyKeysRef` powers the property-key picker's query and `onPropertySelectRef` fires on selection; see #4406
      PropertyPicker.configure({
        items: (query: string) => searchPropertyKeysRef.current(query),
        onSelect: (item: PickerItem) => onPropertySelectRef.current?.(item),
      }),
      // #130 — inline `:` emoji picker. Self-contained (static emoji data +
      // internal insert), so no options to wire.
      EmojiPicker,
      // #907 — passive inline `{{query …}}` syntax hint. Ghost-text only
      // (no `.suggestion-popup`), Tab-to-accept; never intercepts Enter, so
      // block-save always works. Self-contained (vocabulary from query-utils).
      QueryHint,
      // `{{` embed-query picker — discoverable entry to the visual query
      // builder. Reuses the slash-command dispatch (`query` id →
      // openQueryBuilder); hands off to QueryHint once the user types.
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `onSlashCommandRef` here hands the `{{query` picker off to the same slash-command dispatch as above; see #4406
      QueryPicker.configure({
        onCommand: (item: PickerItem) => onSlashCommandRef.current?.(item),
      }),
      // oxlint-disable-next-line react/refs -- the ref is read inside a TipTap `.configure` closure that TipTap invokes at edit/paste/render time, never during this render; handing a ref to a consumer that defers the read is the intended use — `onCheckboxRef` fires when a typed markdown checkbox pattern (`[ ]`/`[x]`) completes; see #4406
      CheckboxInputRule.configure({
        onCheckbox: (state: 'TODO' | 'DONE') => onCheckboxRef.current?.(state),
      }),
      // #1481 — route a pasted single-line GFM task (`- [ ] x`) through the
      // markdown parser so it becomes a task paragraph (carrying `todoState`)
      // instead of literal `- [ ] x` text. Narrowly scoped to task lines on an
      // empty selection; every other paste falls through to default handling.
      TaskPaste,
    ],
    [],
  )

  // #3134 — `immediatelyRender: false` is load-bearing, not a perf tweak.
  //
  // With TipTap's default (`true`), `EditorInstanceManager` constructs the
  // `Editor` inside a `useState` initialiser — i.e. during render — and
  // immediately arms a 1 ms `scheduleDestroy()` timer to reclaim it if the
  // render is never committed. That timer is only disarmed by the passive
  // effect that flips `isComponentMounted`, and React flushes passive effects
  // asynchronously (a separate scheduler task from the commit). On a slow cold
  // boot — this editor pulls a ~50-extension graph, and `RovingEditorHost` sits
  // behind `React.lazy` + `Suspense` — more than 1 ms can elapse between the
  // commit and that flush, so the timer fires first and destroys the editor
  // that `useLazyRovingEditor` had already adopted in its layout effect.
  //
  // `Editor.destroy()` nulls `commandManager` while leaving the instance itself
  // non-null and still referenced by `EditorSurface`, so the next render of
  // `FormattingToolbar`'s `useEditorState` selector threw "Cannot read
  // properties of null (reading 'can')" and the Journal error boundary replaced
  // the entire panel. (TipTap rebuilt an instance moments later, which is why
  // it only ever showed up as e2e flake: fail once, pass on retry.)
  //
  // Deferring construction to the passive effect removes the race outright:
  // the constructor's timer has no editor to reclaim, and every later
  // arm/disarm pair runs back-to-back inside one synchronous effect flush.
  // Both `useRovingEditor` and `useLazyRovingEditor` already treat a null
  // editor as "not live yet" (the stub buffers mounts and replays them on
  // adopt), so the extra render with `editor === null` is an already-supported
  // state, not a new one.
  const editor = useEditor({
    extensions,
    editable: true,
    editorProps: EDITOR_PROPS,
    content: INITIAL_CONTENT,
    immediatelyRender: false,
  })

  // B-77 cleanup layer 5 — when the host component unmounts
  // (e.g. an exception during render that swaps the tree, fast tab switch),
  // TipTap's `useEditor` destroys the editor without going through the
  // suggestion plugin's `onExit`, which can leave orphan popup DOM. Sweep
  // any survivors here so the next mount of the editor never reuses stale
  // popups.
  useEffect(
    () => () => {
      cleanupOrphanedPopups()
    },
    [],
  )

  // Fires on every TipTap `update` while mounted — replaces the old 500ms
  // polling interval in EditableBlock (#536).
  //
  // #2938 — this is now a PURE SIGNAL. It does NOT serialize the document and
  // does NOT touch React state; it only notifies the registered listener that
  // "something changed" so that listener can (re)arm its debounce timers. The
  // actual `getJSON()` + `serialize(...)` happens ON DEMAND when a debounce
  // timer (draft-autosave 2000ms / content-commit 700ms) or a flush fires,
  // reading the live editor at that moment. Because the handler performs no
  // React commit, it cannot re-enter ProseMirror's dispatch via the
  // `DOMObserver` (the #1489 "setState inside dispatch → render → DOM write →
  // dispatch" loop) — there is no render here to begin with.
  const handleEditorUpdate = useCallback(() => {
    onUpdateRef.current?.()
  }, [])

  const mount = useCallback(
    (blockId: string, markdown: string, opts?: MountOptions) => {
      if (!editor) return

      // Detach the update listener before swapping in the new block's document:
      // it is re-attached at the END of mount. If a prior mount left it attached
      // (the no-unmount path — the consumer can reach mount without a preceding
      // unmount when `activeBlockId` is null), mount's own `replaceDocSilently`
      // / focus dispatches below would fire `handleEditorUpdate` and signal a
      // change for the just-swapped-in document — and `editor.on` would stack a
      // SECOND listener copy. `off` is idempotent, so this is a no-op on the
      // normal unmount→mount path where unmount already detached it. (#2938 —
      // the signal no longer serializes, so there is no queued serialize frame
      // to cancel here anymore.)
      editor.off('update', handleEditorUpdate)

      // B-77 fix layer 2: Exit all suggestion plugins BEFORE replacing the
      // document so setMeta({ exit: true }) fires while decorations still
      // exist and the plugin can cleanly call onExit(). Previously this
      // block ran after replaceDocSilently, which destroyed the decorations
      // first and could leave the plugin in a corrupted active state.
      {
        const { tr: suggTr } = editor.state
        for (const key of suggestionPluginKeys) {
          suggTr.setMeta(key, { exit: true })
        }
        suggTr.setMeta('addToHistory', false)
        // Dispatch can throw when the view is torn down between
        // block-switch frames. On the catch path we abort BEFORE the
        // replaceDocSilently below, since that would run against possibly
        // corrupt plugin state. isDestroyed distinguishes the expected race
        // (debug) from an unexpected throw on a live view (warn).
        try {
          editor.view.dispatch(suggTr)
        } catch (err) {
          if (editor.view.isDestroyed) {
            logger.debug('editor', 'suggestion-exit dispatch on destroyed view; aborting', {
              error: err instanceof Error ? err.message : String(err),
            })
          } else {
            logger.warn(
              'editor',
              'suggestion-exit dispatch threw; aborting replaceDocSilently',
              undefined,
              err,
            )
          }
          return
        }
      }

      // B-77 fix layer 3: Remove any orphaned popup DOM elements that
      // survived a broken onExit() lifecycle (e.g. outside-click handler
      // before B-77 fix, or any future edge case).
      cleanupOrphanedPopups()

      // #2275 — parse + replace the document BEFORE committing the identity
      // refs, guarded. `replaceDocSilently` → `editor.schema.nodeFromJSON`
      // throws on schema-invalid JSON; if it does after the refs were already
      // advanced, the editor still holds the OLD block's document while the
      // refs name the NEW block, so the next blur/flush serializes the old
      // content under the new id (silent overwrite). Committing the refs only
      // after a successful replace keeps the prior block's identity intact on
      // failure — the same invariant the #727 suggestion-exit abort gate above
      // protects.
      try {
        const doc = parse(markdown)
        replaceDocSilently(editor, doc as unknown as Record<string, unknown>)
      } catch (err) {
        logger.warn(
          'editor',
          'mount: parse/replaceDocSilently threw; aborting without advancing identity refs',
          { blockId },
          err,
        )
        return
      }

      // #727 — commit the identity refs ONLY after every abort gate (the
      // suggestion-exit dispatch and the doc replace above) has passed. They
      // were previously written at the top of mount(), before the guarded
      // dispatch; when that dispatch threw and we returned, the refs already
      // pointed at the NEW block while the document still held the OLD block's
      // content. The next blur/flush serializes the old doc and attributes it
      // to the new block's id (use-block-flush trusts `handle.activeBlockId`),
      // silently overwriting it. Writing them here means an aborted mount
      // leaves the prior block's identity intact.
      activeBlockIdRef.current = blockId
      originalMarkdownRef.current = markdown
      // Clear undo history so previous block's edits don't leak into this one.
      // We reset the History plugin's internal state directly via setMeta,
      // which avoids state.reconfigure() — reconfigure creates a new plugins
      // array reference that causes ProseMirror's updatePluginViews to destroy
      // and recreate ALL plugin views (including Suggestion views), breaking
      // suggestion popups (slash commands, tag picker, etc.) and adding
      // unnecessary overhead on every block switch.
      // Plugin.key is @internal in ProseMirror's types but always present at runtime
      const histPlugin = editor.state.plugins.find((p) =>
        (p as unknown as { key: string }).key.startsWith('history$'),
      )
      if (histPlugin?.spec.state?.init) {
        const freshHistory = histPlugin.spec.state.init({}, editor.state)
        const { tr } = editor.state
        tr.setMeta(histPlugin, { historyState: freshHistory })
        tr.setMeta('addToHistory', false)
        editor.view.dispatch(tr)
      }
      // #752 — honour the caller's cursor-placement hint (previously the
      // `DeleteBlockOpts.cursorPlacement` contract was documented + passed
      // but silently dropped by this bare `focus()`).
      editor.commands.focus(opts?.cursorPlacement ?? null)
      // #3000 — reset the list marker to `none` so the freshly-mounted block
      // does not inherit the previous block's marker. The focused
      // `EditableBlock` immediately re-sets the correct marker via its effect
      // (→ `updateListMarker`) after this mount completes.
      const markerTr = setListMarkerMeta(editor.state.tr, { style: 'none', ordinal: undefined })
      markerTr.setMeta('addToHistory', false)
      editor.view.dispatch(markerTr)
      editor.on('update', handleEditorUpdate)
    },
    [editor, handleEditorUpdate],
  )

  // #3000 — push the focused block's list marker into the decoration plugin.
  const updateListMarker = useCallback(
    (style: ListMarkerState['style'], ordinal: number | undefined) => {
      if (!editor) return
      const tr = setListMarkerMeta(editor.state.tr, { style, ordinal })
      tr.setMeta('addToHistory', false)
      editor.view.dispatch(tr)
    },
    [editor],
  )

  const unmount = useCallback((): string | null => {
    if (!editor) return null
    const unmountBlockId = activeBlockIdRef.current

    // Detach the update-signal listener before wiping state so it cannot fire
    // against the about-to-be-replaced document.
    editor.off('update', handleEditorUpdate)

    // B-77 fix layer 4: Exit all suggestion plugins before wiping the
    // document.  Without this, blur → unmount → replaceDocSilently
    // destroys decorations while the plugin may still be active.
    {
      const { tr: suggTr } = editor.state
      for (const key of suggestionPluginKeys) {
        suggTr.setMeta(key, { exit: true })
      }
      suggTr.setMeta('addToHistory', false)
      // #727 — guard the dispatch exactly like mount()'s identical exit
      // Dispatch. It can throw when the view is torn down between
      // block-switch frames; unguarded, that throw escaped unmount() ENTIRELY,
      // skipping the serialize-with-plain-text-fallback below — the very
      // data-loss protection it exists for. Unlike mount we do NOT abort on
      // throw: we swallow it and fall through so the content is still captured.
      try {
        editor.view.dispatch(suggTr)
      } catch (err) {
        if (editor.view.isDestroyed) {
          logger.debug('editor', 'unmount suggestion-exit dispatch on destroyed view; continuing', {
            error: err instanceof Error ? err.message : String(err),
          })
        } else {
          logger.warn(
            'editor',
            'unmount suggestion-exit dispatch threw; continuing to serialize',
            undefined,
            err,
          )
        }
      }
    }
    cleanupOrphanedPopups()

    let delta: ContentDelta | null = null
    try {
      const json = editor.getJSON() as DocNode
      delta = computeContentDelta(originalMarkdownRef.current, json)
    } catch (err) {
      // Serialization failed — try plain text fallback to avoid data loss.
      // The editor state is about to be wiped in the finally block, so we
      // must capture SOMETHING here.
      logger.error('editor', 'serialize failed during unmount — attempting plain text fallback', {
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        const plainText = editor.getText()
        if (plainText && plainText !== originalMarkdownRef.current) {
          delta = {
            newMarkdown: plainText,
            changed: true,
            originalMarkdown: originalMarkdownRef.current,
          }
        }
      } catch {
        // Even plain text extraction failed — content is lost
        logger.error('editor', 'plain text fallback also failed — content lost')
      }
    } finally {
      // Always reset editor state
      replaceDocSilently(editor, { type: 'doc', content: [{ type: 'paragraph' }] })
      activeBlockIdRef.current = null
      originalMarkdownRef.current = ''
    }

    logger.debug('editor', 'unmounted', {
      blockId: unmountBlockId,
      changed: delta?.changed ?? false,
    })
    return delta?.changed ? delta.newMarkdown : null
  }, [editor, handleEditorUpdate])

  const getMarkdown = useCallback((): string | null => {
    if (!editor) return null
    const json = editor.getJSON() as DocNode
    return serialize(json, notifyUnknownNodeTypeToast)
  }, [editor])

  // #909 — split the document at the collapsed caret. Returns the markdown of
  // everything BEFORE the caret and everything AFTER it, so Enter can leave the
  // before-text in the current block and seed the new block with the after-text
  // (ProseMirror's splitBlock semantics; marks spanning the caret are carried
  // into each half by `doc.cut`). Returns null when there is no editor or the
  // selection is a range (a non-collapsed selection has no single split point).
  const splitAtCaret = useCallback((): { before: string; after: string } | null => {
    if (!editor) return null
    const { from, empty } = editor.state.selection
    if (!empty) return null
    const { doc } = editor.state
    const before = serialize(doc.cut(0, from).toJSON() as DocNode, notifyUnknownNodeTypeToast)
    const after = serialize(doc.cut(from).toJSON() as DocNode, notifyUnknownNodeTypeToast)
    return { before, after }
  }, [editor])

  // Memoize the returned handle so its object identity is stable across
  // renders that don't change `editor` / `mount` / `unmount` / `getMarkdown`.
  // The two `activeBlockId` / `originalMarkdown` getters read from refs, so
  // they remain live regardless of memo freshness — consumers that need
  // up-to-date values either read them via the getters or capture the
  // handle in a ref (e.g. `src/components/editor/EditableBlock.tsx:273`, `src/components/editor/BlockTree.tsx:508`).
  //
  // Without this, every parent re-render produced a fresh handle object
  // that propagated to `SortableBlockWrapper` and defeated its `React.memo`
  // (design-system-perf-review-2026-05-09.md item 5.)
  const setOnUpdate = useCallback((cb: (() => void) | null) => {
    onUpdateRef.current = cb
  }, [])

  // #2600 — rebase the delta baseline after a mid-typing debounced commit.
  // Guarded on a live mount so a late callback (block already switched away)
  // can't stamp the wrong block's baseline; the unmount path resets it to ''.
  const markCommitted = useCallback((markdown: string) => {
    if (activeBlockIdRef.current !== null) {
      originalMarkdownRef.current = markdown
    }
  }, [])

  return useMemo<RovingEditorHandle>(
    () => ({
      editor,
      mount,
      updateListMarker,
      unmount,
      get activeBlockId() {
        return activeBlockIdRef.current
      },
      getMarkdown,
      splitAtCaret,
      get originalMarkdown() {
        return originalMarkdownRef.current
      },
      setOnUpdate,
      markCommitted,
    }),
    [
      editor,
      mount,
      updateListMarker,
      unmount,
      getMarkdown,
      splitAtCaret,
      setOnUpdate,
      markCommitted,
    ],
  )
}
