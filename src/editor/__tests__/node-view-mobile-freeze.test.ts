/**
 * #4353 — React node views and `@tiptap/core`'s default `ignoreMutation`.
 *
 * The freeze this file is named after is fixed upstream. Up to 3.31.0 the
 * default's mobile branch tested `this.dom.contains(mutation.target)`, so on an
 * iOS/Android UA with the editor focused a `childList` mutation anywhere inside
 * a node view's `dom` was read back as a user edit. A React node view rewrites
 * its own subtree on every render, prosemirror-view flushed those writes, the
 * flush re-rendered the node view, and the cycle never terminated (#4312,
 * #4315). 3.31.3 narrowed the check to `this.contentDOM.contains(target)`, in
 * both `NodeView` and `MarkView`. React chrome lives inside `dom` and outside
 * `contentDOM`, so it no longer reaches the branch.
 *
 * The narrowing also made the branch unobservable: its guard is now the same
 * predicate as the trailing `contentDOM.contains(target)` rule, so its `return
 * false` is only reachable where that rule answers `false` anyway. Nothing
 * below asserts that a user agent changes an answer; the one test that forces a
 * mobile UA does so to enter the branch, so a revert to the `dom`-wide check
 * inverts it.
 *
 * What this file still pins is the classification underneath, because whether
 * prosemirror-view reads a given node view's DOM at all is decided by a
 * structural rule nothing in this repo owns:
 *
 *   1. Every `ReactNodeViewRenderer` call site is enumerated, and a new one
 *      cannot be added without landing in the table here. The enumeration is a
 *      TEXT scan of `src/`, not a resolved-symbol search, so it is only as tight
 *      as the shapes it refuses — see `findCallSites` and the "reaches
 *      `ReactNodeViewRenderer` only by calling it" test for what is closed and
 *      what is still open.
 *   2. Each call site's node type is asserted leaf/atom or neither, against a
 *      schema built from the real extensions rather than their specs.
 *   3. tiptap's `if (this.node.isLeaf || this.node.isAtom) return true`
 *      short-circuit is asserted against the real vendored prototype, so a
 *      `@tiptap/core` bump that drops it reddens this suite rather than
 *      silently changing which mutations prosemirror re-reads. Its sibling,
 *      `if (!this.dom || !this.contentDOM) return true`, is deliberately NOT
 *      pinned, and must not be: with no `options.ignoreMutation` override left
 *      to order it against, the leaf/atom guard answers every input the same
 *      way, so a test for it passes with the guard reconstructed away.
 *   4. The mobile branch's containment test is pinned by its TARGET: chrome is
 *      ignored, a `contentDOM` mutation is not. A revert to the `dom`-wide
 *      check reddens the first arm — which is how the 3.31.3 change was caught
 *      in #5045 rather than read about.
 *
 * Everything here reads the real `NodeView.prototype`, not a transcription of
 * it. The behaviour on a real mobile UA, with the editor genuinely focused, is
 * covered by `e2e/mobile-editor.spec.ts`; this file covers the structure that
 * behaviour depends on.
 */

import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getSchema, NodeView } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { ViewMutationRecord } from '@tiptap/pm/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Image } from '@/editor/extensions/image'
import { MathBlock, MathInline } from '@/editor/extensions/math'
import { CodeBlockWithShortcut } from '@/editor/use-roving-editor'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SRC = join(REPO_ROOT, 'src')

/** The one renderer that mounts a React node view; see `findCallSites`. */
const RENDERER = 'ReactNodeViewRenderer'

interface NodeViewEntry {
  file: string
  node: string
  /**
   * `node.isLeaf` — no `content` in the schema, so `@tiptap/react` builds it no
   * content host and the default's null-`contentDOM` guard answers first.
   */
  isLeaf: boolean
  /** `node.isAtom` — `isLeaf || spec.atom`; the other half of tiptap's
   * `isLeaf || isAtom` short-circuit. */
  isAtom: boolean
  why: string
}

/**
 * Every `ReactNodeViewRenderer` call site in `src/`, and what tiptap's default
 * `ignoreMutation` does with each one. The enumeration test below fails on a
 * call site that is missing from this table, so a node view added later has to
 * be classified rather than inheriting whatever the vendored default does.
 *
 * `isLeaf` / `isAtom` are not style notes, they are the discriminator:
 * `@tiptap/react`'s `ReactNodeView` only builds a `contentDOMElement` when
 * `!node.isLeaf`, and its `contentDOM` getter returns `null` for a leaf — so a
 * leaf node view has no content hole to read, and tiptap's `isLeaf || isAtom`
 * guard answers "ignore everything" for it and for any atom that does declare
 * content. Only a node that is neither has a live content hole whose mutations
 * prosemirror-view re-reads.
 */
const REACT_NODE_VIEWS: Record<string, NodeViewEntry> = {
  ImageNodeView: {
    file: 'src/editor/extensions/image.ts',
    node: 'image',
    isLeaf: true,
    isAtom: true,
    why: '`image` declares no `content`: the src/alt live in attrs.',
  },
  MathInlineNodeView: {
    file: 'src/editor/extensions/math.ts',
    node: 'math_inline',
    isLeaf: true,
    isAtom: true,
    why: '`math_inline` declares no `content`: the LaTeX lives in an attr, edited through a plain <input> outside any content hole.',
  },
  MathBlockNodeView: {
    file: 'src/editor/extensions/math.ts',
    node: 'math_block',
    isLeaf: true,
    isAtom: true,
    why: '`math_block` declares no `content`: same attr-plus-<input> shape as math_inline.',
  },
  MermaidCodeBlockView: {
    file: 'src/editor/use-roving-editor.ts',
    node: 'codeBlock',
    isLeaf: false,
    isAtom: false,
    why: '`codeBlock` has a text content hole that React owns, so both guards pass it through and mutations inside that hole are read as the content edits they are — this is the one that froze.',
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
 * Every non-test `.ts`/`.tsx` source under `src/`, read once and shared by both
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

interface CallSite {
  component: string
  file: string
}

/**
 * Every `ReactNodeViewRenderer(Component…)` call in `files`.
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
 */
function findCallSites(files: SourceFile[]): CallSite[] {
  const sites: CallSite[] = []
  for (const { file, src } of files) {
    // The name is captured OPTIONALLY: a call whose first argument is not a
    // plain identifier must still match, so it lands in the table check with an
    // empty name and reddens, rather than going unseen.
    const re = new RegExp(String.raw`${RENDERER}\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)?`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      sites.push({ component: m[1] ?? '', file })
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
 * Occurrences of `ReactNodeViewRenderer` in `files` that are neither a call nor
 * a plain, UNALIASED named-import specifier.
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
function findIdentifierEscapes(files: SourceFile[]): IdentifierEscape[] {
  const escapes: IdentifierEscape[] = []
  for (const { file, src } of files) {
    // Indices of the two shapes that are allowed to mention the identifier.
    const allowed = new Set<number>()
    for (const call of src.matchAll(new RegExp(String.raw`${RENDERER}\s*(?:<[^>]*>)?\s*\(`, 'g'))) {
      allowed.add(call.index)
    }
    for (const clause of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/g)) {
      const body = clause[1] ?? ''
      const bodyStart = clause.index + clause[0].indexOf('{') + 1
      for (const spec of body.matchAll(identifier(RENDERER))) {
        // `ReactNodeViewRenderer as R` is deliberately NOT allowed: the alias is
        // a spelling the call-site scan cannot see.
        if (/^\s*as\b/.test(body.slice(spec.index + spec[0].length))) continue
        allowed.add(bodyStart + spec.index)
      }
    }

    for (const use of src.matchAll(identifier(RENDERER))) {
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
  const sites = findCallSites(SOURCES)

  it('finds the call sites at all (a zero-length scan would pass every check below)', () => {
    expect(sites.length).toBeGreaterThan(0)
  })

  it('reaches `ReactNodeViewRenderer` only by calling it — no alias, no captured reference', () => {
    // Without this, the scan above is defeated by one `as` in an import and the
    // rest of this suite stays green around an unclassified node view.
    expect(findIdentifierEscapes(SOURCES)).toEqual([])
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
})

describe('#4353 — leaf/atom decides whether tiptap reads a node view at all', () => {
  it.each(Object.entries(REACT_NODE_VIEWS))(
    '%s: node type leaf/atom classification matches the table',
    (_component, entry) => {
      const type = schema.nodes[entry.node]
      expect(type, `node type "${entry.node}" is not in the schema`).toBeDefined()
      expect(type?.isLeaf, entry.why).toBe(entry.isLeaf)
      expect(type?.isAtom, entry.why).toBe(entry.isAtom)
    },
  )
})

// --- The vendored contract the classification above rests on -----------------

interface IgnoreMutationSelf {
  dom: HTMLElement | null
  contentDOM: HTMLElement | null
  node: { isLeaf: boolean; isAtom: boolean }
  options: { ignoreMutation: null }
  editor: { isFocused: boolean }
}

/** tiptap's real default, invoked against a hand-built `this`. */
function defaultIgnoreMutation(this: IgnoreMutationSelf, mutation: ViewMutationRecord): boolean {
  return (
    NodeView.prototype.ignoreMutation as unknown as (
      this: IgnoreMutationSelf,
      mutation: ViewMutationRecord,
    ) => boolean
  ).call(this, mutation)
}

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
 * A `childList` mutation adding a contentEditable node, at whatever target the
 * caller names. Not chrome-specific: callers pass the content host just as
 * often, and on 3.31.3 the target is the only thing that changes the answer.
 */
function childListMutation(target: Node): ViewMutationRecord {
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
  it('the leaf/atom guard answers `true` for an atom that DOES have a contentDOM', () => {
    const { dom, contentHost } = buildNodeViewDom()
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: { isLeaf: false, isAtom: true },
      options: { ignoreMutation: null },
      editor: { isFocused: true },
    }

    // No user agent is forced: the guard fires above the mobile branch, and
    // 3.31.3 left no input where the UA changes an answer.
    //
    // Targeted at the CONTENT host, not the chrome. Since 3.31.3 a chrome
    // mutation answers `true` whatever `isLeaf`/`isAtom` say — it falls through
    // to the trailing `return true` — so a chrome target here would pass with
    // the guard deleted and pin nothing. A contentDOM target answers `true`
    // only because the guard fires; without it the trailing
    // `contentDOM.contains(target)` rule returns `false`.
    //
    // No React node view in this app is in this configuration today; the guard
    // is asserted so the table's `isAtom` column means something if one
    // appears, and so a bump that drops it cannot pass silently.
    expect(defaultIgnoreMutation.call(self, childListMutation(contentHost))).toBe(true)
  })

  it('reads contentDOM mutations only — both arms (#4353 fixed upstream in 3.31.3)', () => {
    useMobileUserAgent()
    const { dom, contentHost, chrome } = buildNodeViewDom()
    const self: IgnoreMutationSelf = {
      dom,
      contentDOM: contentHost,
      node: { isLeaf: false, isAtom: false },
      options: { ignoreMutation: null },
      editor: { isFocused: true },
    }

    // THE FIX. Up to 3.31.0 the mobile branch tested `this.dom.contains(target)`,
    // so React chrome — inside `dom`, outside `contentDOM` — answered `false`
    // ("re-read / re-parse this"), React's own write fed back into
    // prosemirror-view, and that was the freeze. 3.31.3 narrowed the check to
    // `this.contentDOM.contains(target)`, so chrome now falls through to the
    // trailing `return true` and is ignored. A revert reddens this line.
    expect(defaultIgnoreMutation.call(self, childListMutation(chrome))).toBe(true)

    // The content-host arm, for contrast: a mutation genuinely inside
    // `contentDOM` still answers `false`, which is what makes the code block's
    // text hole editable at all.
    expect(defaultIgnoreMutation.call(self, childListMutation(contentHost))).toBe(false)
  })
})
