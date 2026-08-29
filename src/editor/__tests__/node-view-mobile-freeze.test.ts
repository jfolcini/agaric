/**
 * #4353 — the mobile React-node-view freeze, pinned end to end.
 *
 * #4315 established the mechanism: `@tiptap/core`'s default
 * `NodeView.ignoreMutation` carries a branch that, on an iOS/Android user agent
 * with the editor focused, does NOT ignore a `childList` mutation anywhere
 * inside the node view's `dom` — not merely inside `contentDOM`. React rewriting
 * its own subtree therefore reads back as a user edit, prosemirror-view flushes
 * it, the flush re-renders the node view, and the cycle never terminates.
 *
 * The obvious reading of that is "every React node view in the app is exposed",
 * and it is wrong — but only because of two guards ABOVE the branch, in a
 * vendored file, which nothing in this repo owns. This file makes the whole
 * chain fail loudly instead of being re-derived:
 *
 *   1. Every `ReactNodeViewRenderer` call site is enumerated, and a new one
 *      cannot be added without landing in the table here. The enumeration is a
 *      TEXT scan of `src/`, not a resolved-symbol search, so it is only as tight
 *      as the shapes it refuses — see `findCallSites` and the "reaches
 *      `ReactNodeViewRenderer` only by calling it" test for what is closed and
 *      what is still open.
 *   2. Each call site's node type is asserted leaf/atom or neither, because that
 *      is the entire reason three of the four are safe.
 *   3. tiptap's two short-circuits — `if (!this.dom || !this.contentDOM) return
 *      true` and `if (this.node.isLeaf || this.node.isAtom) return true` — are
 *      asserted against the real vendored prototype, so a `@tiptap/core` bump
 *      that drops one reddens this suite rather than silently re-arming the
 *      freeze. The first also fires BEFORE `options.ignoreMutation` is
 *      consulted, which is why the override is not handed to a leaf node view.
 *   4. The branch itself is reproduced against the real prototype under a mobile
 *      user agent, next to `ignoreReactNodeViewChrome` answering the same
 *      mutation correctly — the falsifiable proof that the override is
 *      load-bearing for the one node view that reaches it.
 *   5. React MARK views are ratcheted separately (#4516 review note 1). Marks
 *      are the one class (1)–(4) do not cover, and the more dangerous one: a
 *      mark has no `isLeaf`/`isAtom`, so `MarkView.ignoreMutation` has no guard
 *      (2) to reach, and `ReactMarkView` builds its content host
 *      unconditionally, so guard (1) never fires either. `REACT_MARK_VIEWS` is
 *      empty because `src/` has none — the tests fail the moment one appears.
 *
 * Version note: the snippet #4353 quotes is `MarkView`'s copy of the method.
 * `NodeView`'s (the one React node views run, `@tiptap/core@3.30.2`
 * upstream NodeView.ts, not a path in this repo) carries guard (2) as well,
 * which `MarkView`'s does not —
 * so the blast radius is smaller than the issue assumed. Everything here reads
 * the real `NodeView.prototype` / `MarkView.prototype`, not a transcription of
 * either; the difference between them is asserted differentially, by handing
 * ONE `this` to both.
 *
 * The behaviour on a real mobile UA, with the editor genuinely focused, is
 * covered by `e2e/mobile-editor.spec.ts`; this file covers the structure that
 * behaviour depends on.
 */

import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getSchema, MarkView, NodeView } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { ViewMutationRecord } from '@tiptap/pm/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Image } from '@/editor/extensions/image'
import { MathBlock, MathInline } from '@/editor/extensions/math'
import { ignoreReactNodeViewChrome } from '@/editor/node-view-mutations'
import { CodeBlockWithShortcut } from '@/editor/use-roving-editor'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SRC = join(REPO_ROOT, 'src')

interface NodeViewEntry {
  file: string
  node: string
  /** `node.isLeaf` — no `content` in the schema. Drives tiptap's guard (1). */
  isLeaf: boolean
  /** `node.isAtom` — `isLeaf || spec.atom`. Drives tiptap's guard (2). */
  isAtom: boolean
  why: string
}

/** A node view reaches the mobile branch only if BOTH guards let it through. */
function isExposed(entry: NodeViewEntry): boolean {
  return !entry.isLeaf && !entry.isAtom
}

/**
 * Every `ReactNodeViewRenderer` call site in `src/`, and the reason each one is
 * or is not exposed to the freeze. The enumeration test below fails on a call
 * site that is missing from this table, so a node view added later cannot
 * silently inherit the hazard — it has to be classified first.
 *
 * `isLeaf` / `isAtom` are not style notes, they are the discriminator:
 * `@tiptap/react`'s `ReactNodeView` only builds a `contentDOMElement` when
 * `!node.isLeaf`, and its `contentDOM` getter returns `null` for a leaf — which
 * tiptap's guard (1) turns into "ignore everything" on the FIRST line of
 * `ignoreMutation`, above the `options.ignoreMutation` consultation. Guard (2)
 * catches an atom that does declare content. Only a node that is neither
 * reaches the mobile branch and needs the override.
 */
const REACT_NODE_VIEWS: Record<string, NodeViewEntry> = {
  ImageNodeView: {
    file: 'src/editor/extensions/image.ts',
    node: 'image',
    isLeaf: true,
    isAtom: true,
    why: '`image` declares no `content` — the src/alt live in attrs — so contentDOM is null and tiptap ignores every mutation before the mobile branch.',
  },
  MathInlineNodeView: {
    file: 'src/editor/extensions/math.ts',
    node: 'math_inline',
    isLeaf: true,
    isAtom: true,
    why: '`math_inline` declares no `content` (the LaTeX lives in an attr, edited through a plain <input>), so it is a leaf atom.',
  },
  MathBlockNodeView: {
    file: 'src/editor/extensions/math.ts',
    node: 'math_block',
    isLeaf: true,
    isAtom: true,
    why: '`math_block` declares no `content` (same attr-plus-<input> shape as math_inline), so it is a leaf atom.',
  },
  MermaidCodeBlockView: {
    file: 'src/editor/use-roving-editor.ts',
    node: 'codeBlock',
    isLeaf: false,
    isAtom: false,
    why: '`codeBlock` has a text content hole that React owns, so both guards pass it through to the mobile branch — this is the one that froze, and the one that needs the override.',
  },
}

/** Recursively list `.ts` / `.tsx` files under `dir`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** One scanned source file: its repo-relative path and its text. */
interface SourceFile {
  file: string
  src: string
}

/**
 * Every non-test `.ts`/`.tsx` source under `src/`, read once and shared by all
 * the scanners below so the corpus they judge is provably the same one.
 */
function readSources(): SourceFile[] {
  return sourceFiles(SRC)
    .filter((file) => !file.includes('__tests__'))
    .map((file) => ({
      file: relative(REPO_ROOT, file).replaceAll('\\', '/'),
      src: readFileSync(file, 'utf8'),
    }))
}

/**
 * Slice the argument list of the `<renderer>(` call starting at `openParen`, by
 * balancing parentheses. Used to ask whether the call passes an
 * `ignoreMutation` option without depending on how the object literal is
 * formatted.
 */
function callArguments(src: string, openParen: number, renderer: string): string {
  let depth = 0
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(openParen + 1, i)
    }
  }
  throw new Error(`unbalanced parentheses after ${renderer}(`)
}

interface CallSite {
  component: string
  file: string
  args: string
}

/**
 * Every `<renderer>(Component…)` call in `files` — `ReactNodeViewRenderer` for
 * the node-view table, `ReactMarkViewRenderer` for the mark-view one.
 *
 * This is a text scan, not a resolved-symbol search: Serena/tsserver cannot index
 * `node_modules`, so there is no reference search on the declaration to lean on.
 * A text scan only sees the spellings it is written to see, which is why
 * `reaches ReactNodeViewRenderer only by calling it` below refuses every OTHER
 * spelling rather than trusting this regex to be exhaustive — an aliased import
 * (`ReactNodeViewRenderer as R`) or a captured reference (`const r =
 * ReactNodeViewRenderer`) would otherwise mount an unclassified React node view
 * with the whole table still green. A `tiptapReact.ReactNodeViewRenderer(X)`
 * member call IS matched here, because the regex anchors on the identifier and
 * the `(` rather than on the import.
 *
 * Parameterised over both the renderer name and the corpus so the mark-view
 * ratchet runs the SAME scanner, and so both can be pointed at a synthetic
 * source to prove they are capable of finding anything at all.
 */
function findCallSites(renderer: string, files: SourceFile[]): CallSite[] {
  const sites: CallSite[] = []
  for (const { file, src } of files) {
    const re = new RegExp(String.raw`${renderer}\s*(?:<[^>]*>)?\s*\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const openParen = m.index + m[0].length - 1
      const args = callArguments(src, openParen, renderer)
      const component = (args.match(/^\s*([A-Za-z_$][\w$]*)/)?.[1] ?? '').trim()
      sites.push({ component, file, args })
    }
  }
  return sites
}

/**
 * A FRESH `/g` matcher per call. A shared one would carry `lastIndex` into every
 * `matchAll`, which is the classic way a scan like this quietly stops finding
 * things after the first file.
 */
const identifier = (name: string): RegExp => new RegExp(String.raw`\b${name}\b`, 'g')

/**
 * True when `index` falls on a line that has already entered a comment — a jsdoc
 * continuation (` * …`), a `//` line comment, or a `/* …` opener. Prose mentions
 * of the identifier are not call sites and must not redden the scan below.
 */
function isInComment(src: string, index: number): boolean {
  const before = src.slice(src.lastIndexOf('\n', index - 1) + 1, index)
  return /^\s*(?:\/\/|\*|\/\*)/.test(before) || before.includes('//')
}

interface IdentifierEscape {
  file: string
  context: string
}

/**
 * Occurrences of the identifier `renderer` in `files` that are neither a call
 * nor a plain, UNALIASED named-import specifier.
 *
 * This is the half of the ratchet that makes the call-site scan trustworthy.
 * The scan can only recognise the literal spelling `ReactNodeViewRenderer(`, so
 * on its own it is silently defeated by any indirection:
 *
 * ```ts
 * import { ReactNodeViewRenderer as R } from '@tiptap/react'
 * addNodeView: () => R(SomeNewView)          // invisible to findCallSites()
 * ```
 *
 * Verified: with that file present and nothing else changed, every other test in
 * this suite stays green while an unclassified React node view is mounted. So
 * rather than trying to teach the scan more spellings, every occurrence of the
 * identifier is required to be one of exactly two shapes — a call, or an
 * unaliased import of it — and anything else fails HERE, naming the file. That
 * closes aliasing, `const r = ReactNodeViewRenderer`, destructuring off a
 * dynamic `import()`, and passing the function somewhere as a value.
 *
 * What remains open, and is accepted: reaching the export without ever writing
 * its name (`mod['ReactNodeViewRen' + 'derer']`), re-exporting it from a local
 * module under another name, or hand-constructing `ReactNodeView` instead of
 * calling the renderer at all. Those are deliberate evasions rather than the
 * ordinary way a node view gets added, and the e2e specs remain the backstop.
 */
function findIdentifierEscapes(renderer: string, files: SourceFile[]): IdentifierEscape[] {
  const escapes: IdentifierEscape[] = []
  for (const { file, src } of files) {
    // Indices of the two shapes that are allowed to mention the identifier.
    const allowed = new Set<number>()
    for (const call of src.matchAll(new RegExp(String.raw`${renderer}\s*(?:<[^>]*>)?\s*\(`, 'g'))) {
      allowed.add(call.index)
    }
    for (const clause of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/g)) {
      const body = clause[1] ?? ''
      const bodyStart = clause.index + clause[0].indexOf('{') + 1
      for (const spec of body.matchAll(identifier(renderer))) {
        // `ReactNodeViewRenderer as R` is deliberately NOT allowed: the alias is
        // a spelling the call-site scan cannot see.
        if (/^\s*as\b/.test(body.slice(spec.index + spec[0].length))) continue
        allowed.add(bodyStart + spec.index)
      }
    }

    for (const use of src.matchAll(identifier(renderer))) {
      if (allowed.has(use.index) || isInComment(src, use.index)) continue
      escapes.push({
        file,
        context: src.slice(Math.max(0, use.index - 60), use.index + 60).replaceAll('\n', ' '),
      })
    }
  }
  return escapes
}

const schema = getSchema([
  Document,
  Paragraph,
  Text,
  Image,
  MathInline,
  MathBlock,
  CodeBlockWithShortcut,
])

const SOURCES = readSources()

describe('#4353 — every React node view call site is classified', () => {
  const sites = findCallSites('ReactNodeViewRenderer', SOURCES)

  it('finds the call sites at all (a zero-length scan would pass every check below)', () => {
    expect(sites.length).toBeGreaterThan(0)
  })

  it('reaches `ReactNodeViewRenderer` only by calling it — no alias, no captured reference', () => {
    // Without this, the scan above is defeated by one `as` in an import and the
    // rest of this suite stays green around an unclassified node view.
    expect(findIdentifierEscapes('ReactNodeViewRenderer', SOURCES)).toEqual([])
  })

  it('enumerates exactly the call sites recorded in REACT_NODE_VIEWS', () => {
    const found = [...new Set(sites.map((s) => s.component))].toSorted()
    expect(found).toEqual(Object.keys(REACT_NODE_VIEWS).toSorted())
  })

  it('records each call site in the file it actually lives in', () => {
    for (const site of sites) {
      expect(REACT_NODE_VIEWS[site.component]?.file).toBe(site.file)
    }
  })

  it('passes `ignoreMutation` at every EXPOSED call site, and at no protected one', () => {
    for (const site of sites) {
      const entry = REACT_NODE_VIEWS[site.component]
      expect(entry, `unclassified call site: ${site.component}`).toBeDefined()
      // A leaf/atom call site must NOT carry the option: tiptap never consults
      // it there, so it would read as protection that is not doing anything.
      expect(site.args.includes('ignoreMutation'), site.component).toBe(
        entry !== undefined && isExposed(entry),
      )
    }
  })

  it('routes the exposed call site through the SHARED helper, not a hand-copied body', () => {
    for (const site of sites) {
      const entry = REACT_NODE_VIEWS[site.component]
      if (entry === undefined || !isExposed(entry)) continue
      expect(site.args, site.component).toContain('ignoreMutation: ignoreReactNodeViewChrome')
    }
  })
})

describe('#4353 — leaf/atom is what makes a React node view safe', () => {
  it.each(Object.entries(REACT_NODE_VIEWS))(
    '%s: node type leaf/atom classification matches the table',
    (_component, entry) => {
      const type = schema.nodes[entry.node]
      expect(type, `node type "${entry.node}" is not in the schema`).toBeDefined()
      expect(type?.isLeaf, entry.why).toBe(entry.isLeaf)
      expect(type?.isAtom, entry.why).toBe(entry.isAtom)
    },
  )

  it('covers both classes (a table that drifted all-atom would make the override untested)', () => {
    const exposure = Object.values(REACT_NODE_VIEWS).map(isExposed)
    expect(exposure).toContain(true)
    expect(exposure).toContain(false)
  })
})

// --- The vendored contract the classification above rests on -----------------

interface IgnoreMutationSelf {
  dom: HTMLElement | null
  contentDOM: HTMLElement | null
  node: { isLeaf: boolean; isAtom: boolean }
  options: { ignoreMutation: ((props: { mutation: ViewMutationRecord }) => boolean) | null }
  editor: { isFocused: boolean }
}

/** The `this` of a node view that is neither leaf nor atom — i.e. `codeBlock`. */
const EXPOSED_NODE = { isLeaf: false, isAtom: false }

/** tiptap's real default, invoked against a hand-built `this`. */
const defaultIgnoreMutation = NodeView.prototype.ignoreMutation as unknown as (
  this: IgnoreMutationSelf,
  mutation: ViewMutationRecord,
) => boolean

/** A node view DOM: a React content host plus some React-owned chrome beside it. */
function buildNodeViewDom(): { dom: HTMLElement; contentHost: HTMLElement; chrome: HTMLElement } {
  const dom = document.createElement('div')
  const contentHost = document.createElement('div')
  contentHost.setAttribute('data-node-view-content-react', '')
  const chrome = document.createElement('span')
  dom.append(contentHost, chrome)
  return { dom, contentHost, chrome }
}

/**
 * A `childList` mutation on React's own chrome, adding a contentEditable node —
 * i.e. exactly the shape the mobile branch refuses to ignore.
 */
function chromeChildListMutation(target: Node): ViewMutationRecord {
  const added = document.createElement('span')
  Object.defineProperty(added, 'isContentEditable', { value: true, configurable: true })
  return {
    type: 'childList',
    target,
    addedNodes: [added] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
  } as unknown as ViewMutationRecord
}

/** Force `isAndroid()` (and so the mobile branch) true for the duration of a test. */
function useMobileUserAgent(): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('#4353 — @tiptap/core default ignoreMutation (vendored contract)', () => {
  it('guard (1): answers `true` when contentDOM is null WITHOUT consulting options.ignoreMutation', () => {
    useMobileUserAgent()
    const { dom, chrome } = buildNodeViewDom()
    const override = vi.fn(() => false)
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: null,
      // A leaf node view is what produces `contentDOM === null` in
      // `@tiptap/react`; the guard itself only reads `contentDOM`.
      node: { isLeaf: true, isAtom: true },
      options: { ignoreMutation: override },
      editor: { isFocused: true },
    }

    // This is the first of the two reasons `image` / `math_inline` /
    // `math_block` are safe, AND the reason giving them the override would be
    // dead code: the option is never read.
    expect(defaultIgnoreMutation.call(self, chromeChildListMutation(chrome))).toBe(true)
    expect(override).not.toHaveBeenCalled()
  })

  it('guard (2): answers `true` for an atom that DOES have a contentDOM', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildNodeViewDom()
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: { isLeaf: false, isAtom: true },
      options: { ignoreMutation: null },
      editor: { isFocused: true },
    }

    // No React node view in this app is in this configuration today; the guard
    // is asserted so the table's `isAtom` column means something if one appears.
    expect(defaultIgnoreMutation.call(self, chromeChildListMutation(chrome))).toBe(true)
  })

  it('DOES consult options.ignoreMutation for an exposed view, before the mobile branch', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildNodeViewDom()
    const override = vi.fn(() => true)
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: EXPOSED_NODE,
      options: { ignoreMutation: override },
      editor: { isFocused: true },
    }

    expect(defaultIgnoreMutation.call(self, chromeChildListMutation(chrome))).toBe(true)
    expect(override).toHaveBeenCalledTimes(1)
  })

  it('without an override, refuses to ignore React chrome on a mobile UA with the editor focused', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildNodeViewDom()
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: EXPOSED_NODE,
      options: { ignoreMutation: null },
      editor: { isFocused: true },
    }
    const mutation = chromeChildListMutation(chrome)

    // `false` = "re-read / re-parse this" — React's own write fed back into
    // prosemirror-view. That is the freeze.
    expect(defaultIgnoreMutation.call(self, mutation)).toBe(false)
    // …and this is what the override answers for the same mutation.
    expect(ignoreReactNodeViewChrome({ mutation })).toBe(true)
  })

  it('ignores the same mutation on a DESKTOP UA — which is why the freeze was UA-gated', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    )
    const { dom, contentHost, chrome } = buildNodeViewDom()
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: EXPOSED_NODE,
      options: { ignoreMutation: null },
      editor: { isFocused: true },
    }

    expect(defaultIgnoreMutation.call(self, chromeChildListMutation(chrome))).toBe(true)
  })

  it('ignores the same mutation on a mobile UA while the editor is NOT focused', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildNodeViewDom()
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: EXPOSED_NODE,
      options: { ignoreMutation: null },
      editor: { isFocused: false },
    }

    expect(defaultIgnoreMutation.call(self, chromeChildListMutation(chrome))).toBe(true)
  })
})

describe('ignoreReactNodeViewChrome', () => {
  it('does not ignore a selection change (prosemirror must re-read it)', () => {
    const { contentHost } = buildNodeViewDom()
    const mutation = { type: 'selection', target: contentHost } as unknown as ViewMutationRecord
    expect(ignoreReactNodeViewChrome({ mutation })).toBe(false)
  })

  it('does not ignore a content edit inside the content hole', () => {
    const { contentHost } = buildNodeViewDom()
    const inner = document.createElement('span')
    contentHost.append(inner)
    expect(ignoreReactNodeViewChrome({ mutation: chromeChildListMutation(inner) })).toBe(false)
  })

  it('does not ignore a childList mutation on the content host itself', () => {
    const { contentHost } = buildNodeViewDom()
    expect(ignoreReactNodeViewChrome({ mutation: chromeChildListMutation(contentHost) })).toBe(
      false,
    )
  })

  it('ignores an attribute write on the content host (React re-rendering the wrapper)', () => {
    const { contentHost } = buildNodeViewDom()
    const mutation = {
      type: 'attributes',
      target: contentHost,
      attributeName: 'class',
    } as unknown as ViewMutationRecord
    expect(ignoreReactNodeViewChrome({ mutation })).toBe(true)
  })

  it('ignores chrome outside the content hole', () => {
    const { chrome } = buildNodeViewDom()
    expect(ignoreReactNodeViewChrome({ mutation: chromeChildListMutation(chrome) })).toBe(true)
  })

  it('resolves a text-node target through its parent element', () => {
    const { contentHost, chrome } = buildNodeViewDom()
    const insideText = document.createTextNode('code')
    contentHost.append(insideText)
    const outsideText = document.createTextNode('chrome')
    chrome.append(outsideText)

    expect(ignoreReactNodeViewChrome({ mutation: chromeChildListMutation(insideText) })).toBe(false)
    expect(ignoreReactNodeViewChrome({ mutation: chromeChildListMutation(outsideText) })).toBe(true)
  })
})

// --- React MARK views: the class the node-view ratchet above does NOT cover --

/**
 * #4516 review note 1 — the enumeration above ratchets `ReactNodeViewRenderer`
 * only, and a React MARK view is the one class its "cannot be added without
 * landing in the table" property misses.
 *
 * Marks are not merely an untested corner of the same mechanism, they are the
 * WORSE case. `MarkView.prototype.ignoreMutation` (asserted below, not
 * transcribed) carries guard (1) but has no guard (2) at all — a mark has no
 * `isLeaf`/`isAtom` to check — and `@tiptap/react`'s `ReactMarkView` builds its
 * `contentDOMElement` unconditionally, so guard (1) never fires either. Every
 * React mark view therefore reaches the mobile branch. Where three of the four
 * node views are protected by the schema, NO mark view is: the override is the
 * only thing between one and the freeze.
 *
 * `src/` has zero mark views today, so this table is empty on purpose. It is a
 * ratchet, not a record: the tests below fail the moment a mark view appears
 * anywhere in `src/` — by `ReactMarkViewRenderer` or by a bare `addMarkView` —
 * and cannot be made green except by classifying it here.
 */
interface MarkViewEntry {
  file: string
  /** The mark type name, as declared by the extension mounting this view. */
  mark: string
  /**
   * The attribute selector that identifies THIS mark view's ProseMirror content
   * hole, for whatever `ignoreMutation` it passes.
   *
   * Required because the obvious move — reusing `ignoreReactNodeViewChrome` —
   * is wrong here and quietly so: that helper matches
   * `[data-node-view-content-react]`, tiptap stamps a React mark view's content
   * host with `data-mark-view-content`, and `closest()` finding nothing is the
   * helper's "React chrome, ignore it" answer. It would swallow every real edit
   * inside the mark. Pinned by the last test in this file.
   */
  contentHostSelector: string
  why: string
}

const REACT_MARK_VIEWS: Record<string, MarkViewEntry> = {}

/** The node-view content host `ignoreReactNodeViewChrome` recognises. */
const NODE_VIEW_CONTENT_HOST = '[data-node-view-content-react]'

/**
 * Files under `src/` that declare an `addMarkView`, the extension hook every
 * mark view — React-rendered or hand-built — has to go through to be mounted.
 *
 * Scanned in addition to `ReactMarkViewRenderer` because the renderer is only
 * the common way to build one: `addMarkView: () => new SomeMarkView(...)` never
 * mentions the identifier and would slip past the call-site scan entirely.
 *
 * What stays open, and is accepted, mirrors the node-view scan: reaching the
 * hook without writing its name, or a mark view mounted from outside `src/`.
 */
function findAddMarkViewSites(files: SourceFile[]): string[] {
  const hits: string[] = []
  for (const { file, src } of files) {
    for (const use of src.matchAll(/\baddMarkView\b/g)) {
      if (isInComment(src, use.index)) continue
      hits.push(file)
    }
  }
  return [...new Set(hits)].toSorted()
}

/**
 * A synthetic mark view, used ONLY to prove the scanners above are capable of
 * finding one. Every real-corpus assertion in this section compares against an
 * empty table, and an empty expectation is satisfied by a scanner that has
 * quietly stopped working — the exact failure `finds the call sites at all`
 * guards against for node views. This fixture is fed through the SAME
 * functions the real corpus goes through.
 */
const MARK_VIEW_PROBE: SourceFile = {
  file: 'src/editor/extensions/__probe__.ts',
  src: [
    `import { ReactMarkViewRenderer } from '@tiptap/react'`,
    `export const Probe = Mark.create({`,
    `  addMarkView() {`,
    `    return ReactMarkViewRenderer(ProbeMarkView)`,
    `  },`,
    `})`,
  ].join('\n'),
}

describe('#4516 follow-up — every React MARK view is classified', () => {
  const sites = findCallSites('ReactMarkViewRenderer', SOURCES)

  it('the scanners can actually see a mark view (an empty table makes every check below vacuous otherwise)', () => {
    const probeSites = findCallSites('ReactMarkViewRenderer', [MARK_VIEW_PROBE])
    expect(probeSites.map((s) => s.component)).toEqual(['ProbeMarkView'])
    expect(probeSites[0]?.file).toBe(MARK_VIEW_PROBE.file)
    expect(findAddMarkViewSites([MARK_VIEW_PROBE])).toEqual([MARK_VIEW_PROBE.file])
    // …and the escape scan, on the shape that defeats the call-site scan.
    const aliased: SourceFile = {
      file: MARK_VIEW_PROBE.file,
      src: `import { ReactMarkViewRenderer as R } from '@tiptap/react'\nconst v = R(ProbeMarkView)\n`,
    }
    expect(findIdentifierEscapes('ReactMarkViewRenderer', [aliased])).not.toEqual([])
    // The probe is a string, not a file: it must not be in the real corpus.
    expect(SOURCES.some((s) => s.file === MARK_VIEW_PROBE.file)).toBe(false)
  })

  it('enumerates exactly the mark views recorded in REACT_MARK_VIEWS', () => {
    const found = [...new Set(sites.map((s) => s.component))].toSorted()
    expect(found).toEqual(Object.keys(REACT_MARK_VIEWS).toSorted())
  })

  it('records each mark view call site in the file it actually lives in', () => {
    for (const site of sites) {
      expect(REACT_MARK_VIEWS[site.component]?.file).toBe(site.file)
    }
  })

  it('reaches `ReactMarkViewRenderer` only by calling it — no alias, no captured reference', () => {
    expect(findIdentifierEscapes('ReactMarkViewRenderer', SOURCES)).toEqual([])
  })

  it('declares `addMarkView` only in files the table names', () => {
    const declared = [...new Set(Object.values(REACT_MARK_VIEWS).map((e) => e.file))].toSorted()
    expect(findAddMarkViewSites(SOURCES)).toEqual(declared)
  })

  it('passes `ignoreMutation` at EVERY mark view call site — none of them is protected by the schema', () => {
    for (const site of sites) {
      const entry = REACT_MARK_VIEWS[site.component]
      expect(entry, `unclassified mark view call site: ${site.component}`).toBeDefined()
      // Unconditional, unlike the node-view assertion: there is no leaf/atom
      // escape for a mark, so an override is the only protection there is.
      expect(site.args.includes('ignoreMutation'), site.component).toBe(true)
    }
  })

  it('reuses `ignoreReactNodeViewChrome` only where the content host is the node-view one', () => {
    for (const site of sites) {
      const entry = REACT_MARK_VIEWS[site.component]
      if (entry === undefined) continue
      if (entry.contentHostSelector === NODE_VIEW_CONTENT_HOST) continue
      expect(
        site.args,
        `${site.component} pastes a helper that cannot see its content hole`,
      ).not.toContain('ignoreReactNodeViewChrome')
    }
  })
})

/** A React MARK view's DOM: tiptap stamps the content host `data-mark-view-content`. */
function buildMarkViewDom(): { dom: HTMLElement; contentHost: HTMLElement; chrome: HTMLElement } {
  const dom = document.createElement('span')
  const contentHost = document.createElement('span')
  contentHost.setAttribute('data-mark-view-content', '')
  const chrome = document.createElement('span')
  dom.append(contentHost, chrome)
  return { dom, contentHost, chrome }
}

interface MarkIgnoreMutationSelf {
  dom: HTMLElement | null
  contentDOM: HTMLElement | null
  /**
   * Present only so the differential test below can hand `MarkView` the very
   * `this` a `NodeView` would refuse on — a real mark view has no `node`.
   */
  node?: { isLeaf: boolean; isAtom: boolean }
  options: { ignoreMutation: ((props: { mutation: ViewMutationRecord }) => boolean) | null }
  editor: { isFocused: boolean }
}

/** tiptap's real `MarkView` default, invoked against a hand-built `this`. */
const defaultMarkIgnoreMutation = MarkView.prototype.ignoreMutation as unknown as (
  this: MarkIgnoreMutationSelf,
  mutation: ViewMutationRecord,
) => boolean

describe('#4516 follow-up — @tiptap/core MarkView.ignoreMutation (vendored contract)', () => {
  it('has NO leaf/atom guard: the same `this` a NodeView ignores, a MarkView does not', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildMarkViewDom()
    // One object, handed to both prototypes. `isLeaf`/`isAtom` are set to the
    // values that make NodeView bail at guard (2); MarkView has no such guard
    // to reach, which is the whole claim — asserted differentially against the
    // real vendored functions rather than transcribed from the source.
    const self: MarkIgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: { isLeaf: true, isAtom: true },
      options: { ignoreMutation: null },
      editor: { isFocused: true },
    }
    const mutation = chromeChildListMutation(chrome)

    expect(defaultIgnoreMutation.call(self as unknown as IgnoreMutationSelf, mutation)).toBe(true)
    // `false` = "re-read / re-parse this". That is the freeze, on a mark view
    // that the node-view table would have classified as protected.
    expect(defaultMarkIgnoreMutation.call(self, mutation)).toBe(false)
  })

  it('consults options.ignoreMutation, so an override is the only protection a mark view has', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildMarkViewDom()
    const override = vi.fn(() => true)
    const self: MarkIgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      options: { ignoreMutation: override },
      editor: { isFocused: true },
    }

    expect(defaultMarkIgnoreMutation.call(self, chromeChildListMutation(chrome))).toBe(true)
    expect(override).toHaveBeenCalledTimes(1)
  })

  it('`ignoreReactNodeViewChrome` is NOT a drop-in: it swallows a real edit inside a mark content hole', () => {
    const { contentHost } = buildMarkViewDom()
    const inner = document.createElement('span')
    contentHost.append(inner)
    const mutation = chromeChildListMutation(inner)

    // The correct answer for a content edit is `false` (prosemirror must read
    // it) — which is exactly what the helper returns for the NODE view shape.
    // Here `closest('[data-node-view-content-react]')` finds nothing, the
    // helper reads that as "React chrome", and answers `true`: ignore it.
    // Pasting it onto a mark view therefore does not merely fail to protect,
    // it drops the mark's edits. Hence `MarkViewEntry.contentHostSelector`.
    expect(ignoreReactNodeViewChrome({ mutation })).toBe(true)
    const nodeShaped = buildNodeViewDom()
    const nodeInner = document.createElement('span')
    nodeShaped.contentHost.append(nodeInner)
    expect(ignoreReactNodeViewChrome({ mutation: chromeChildListMutation(nodeInner) })).toBe(false)
  })
})
