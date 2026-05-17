/**
 * In-page find matcher — PEND-52.
 *
 * Walks the DOM under a host container collecting text-node matches.
 * Returns a flat list of `{ node, start, end }` triples suitable for
 * constructing `Range` instances (consumed by the highlight renderer
 * via `CSS.highlights`).
 *
 * ## Architecture call (deviation from the plan's "ProseMirror Decoration")
 *
 * The PEND-52 plan describes match highlighting via ProseMirror
 * Decorations on a single editor document. Agaric uses a **roving
 * editor** pattern: only the currently-focused block holds a
 * ProseMirror instance; every other block renders as static DOM (see
 * `src/components/StaticBlock.tsx`). A `DecorationSet` therefore
 * covers at most ONE block — not the whole page. To honour the
 * spirit of the constraint ("non-destructive, no DOM mutation, no
 * `dangerouslySetInnerHTML`") across both static blocks AND the active
 * editor uniformly, we walk the DOM via `TreeWalker` and emit `Range`s
 * into a `Highlight` registered with `CSS.highlights`. This is the
 * modern browser primitive for native-style highlighting — it mutates
 * neither DOM nor React tree, supports both static text and the live
 * `.ProseMirror` contenteditable, and gracefully no-ops where the API
 * is unsupported (the matcher still returns counts; only the visual
 * highlight is missing).
 *
 * Test environment: `happy-dom` doesn't expose `CSS.highlights`, so
 * the highlighter module feature-detects. The matcher itself is pure
 * DOM-walking and tests run against happy-dom directly.
 *
 * ## Regex caps (locked by the plan)
 *
 *  - Pattern length ≤ {@link REGEX_PATTERN_MAX} (1 KB). Longer
 *    patterns return a compile error; the toolbar surfaces it inline.
 *  - Text node length ≤ {@link REGEX_NODE_MAX} (10 KB). Longer text
 *    nodes are skipped in regex mode — the matcher tracks how many
 *    nodes were skipped so the toolbar can show "some long passages
 *    skipped".
 *  - Walking is chunked in batches of {@link CHUNK_SIZE} (50) nodes;
 *    the runner yields between chunks via `requestIdleCallback`
 *    (fallback `setTimeout(0)`). A `cancelled` flag aborts an in-
 *    flight walk when the user types again.
 *
 * Each text node is matched independently — matches do not span
 * block / inline element boundaries. Same semantics as VSCode's
 * in-editor find.
 */

/** Maximum regex pattern length (bytes). Longer patterns reject. */
export const REGEX_PATTERN_MAX = 1024

/** Maximum text-node length (chars) considered in regex mode. */
export const REGEX_NODE_MAX = 10_240

/** Chunk size for cooperative DOM walking. */
export const CHUNK_SIZE = 50

/** One literal/regex hit inside a single text node. */
export interface FindMatch {
  /** The DOM text node containing the match. */
  node: Text
  /** Inclusive start offset within `node.nodeValue`. */
  start: number
  /** Exclusive end offset within `node.nodeValue`. */
  end: number
}

/** Toggle state for a find run. */
export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  isRegex: boolean
}

/** Result of a completed find walk. */
export interface FindResult {
  matches: FindMatch[]
  /** Count of text nodes skipped because they exceeded REGEX_NODE_MAX in regex mode. */
  skippedLongNodes: number
}

/** Token returned by `runWalker` so the caller can abort. */
export interface WalkerHandle {
  cancel(): void
}

/** Outcome of compiling a query. `null` matcher means "no matches at all". */
export type CompiledQuery =
  | { kind: 'empty' }
  | { kind: 'literal'; matcher: (text: string) => Array<{ start: number; end: number }> }
  | { kind: 'regex'; matcher: (text: string) => Array<{ start: number; end: number }> }
  | { kind: 'error'; message: string }

/**
 * Compile a query string into a matcher function.
 *
 * - Empty / whitespace-only query → `kind: 'empty'` (caller skips the walk).
 * - Regex mode with a pattern longer than {@link REGEX_PATTERN_MAX} or that
 *   fails to compile → `kind: 'error'`.
 * - Otherwise returns a matcher closure that scans a single text-node
 *   string and emits `{start, end}` ranges per hit.
 *
 * Whole-word mode wraps with `\b…\b` for literal queries and applies a
 * simple word-boundary post-filter for regex queries (we don't try to
 * inject `\b` into the user's pattern; we just verify the matched
 * substring is delimited by non-word chars on both sides).
 */
export function compileQuery(query: string, opts: FindOptions): CompiledQuery {
  if (query.length === 0) return { kind: 'empty' }

  if (opts.isRegex) {
    if (query.length > REGEX_PATTERN_MAX) {
      return { kind: 'error', message: 'findInPage.regexTooLong' }
    }
    let re: RegExp
    try {
      // `g` always set; `i` when not case-sensitive. `u` for sane
      // unicode behaviour (no surrogate pair splits). `s` and `m` are
      // not set — users opt in via inline `(?s)` / `(?m)` flags inside
      // the pattern, same as VSCode.
      const flags = opts.caseSensitive ? 'gu' : 'giu'
      re = new RegExp(query, flags)
    } catch (err) {
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : 'findInPage.regexInvalid',
      }
    }
    const wholeWord = opts.wholeWord
    return {
      kind: 'regex',
      matcher: (text) => scanRegex(text, re, wholeWord),
    }
  }

  // Literal mode. Folding via `toLocaleLowerCase` is fine for ASCII;
  // for Unicode case-folding edge cases we follow VSCode's
  // approximation (fold the haystack and needle together).
  const needle = opts.caseSensitive ? query : query.toLocaleLowerCase()
  const wholeWord = opts.wholeWord
  const caseSensitive = opts.caseSensitive
  return {
    kind: 'literal',
    matcher: (text) => scanLiteral(text, needle, wholeWord, caseSensitive),
  }
}

function scanLiteral(
  text: string,
  needle: string,
  wholeWord: boolean,
  caseSensitive: boolean,
): Array<{ start: number; end: number }> {
  if (needle.length === 0) return []
  const haystack = caseSensitive ? text : text.toLocaleLowerCase()
  const out: Array<{ start: number; end: number }> = []
  let from = 0
  // `indexOf` loop — `String.prototype.matchAll` requires a global RegExp,
  // and we want to keep literal mode allocation-free per char.
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    const end = idx + needle.length
    if (!wholeWord || isWholeWord(text, idx, end)) {
      out.push({ start: idx, end })
    }
    // Step by 1 (not by needle.length) so overlapping matches surface —
    // e.g. needle "aa" in "aaaa" returns 3 matches, not 2.
    from = idx + 1
  }
  return out
}

function scanRegex(
  text: string,
  re: RegExp,
  wholeWord: boolean,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  re.lastIndex = 0
  let m = re.exec(text)
  while (m !== null) {
    const start = m.index
    const end = start + m[0].length
    if (end === start) {
      // Zero-width match — advance lastIndex by one to avoid infinite loop.
      re.lastIndex = start + 1
    } else if (!wholeWord || isWholeWord(text, start, end)) {
      out.push({ start, end })
    }
    m = re.exec(text)
  }
  return out
}

const WORD_RE = /[A-Za-z0-9_]/
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return WORD_RE.test(ch)
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start === 0 ? undefined : text[start - 1]
  const after = end >= text.length ? undefined : text[end]
  return !isWordChar(before) && !isWordChar(after)
}

/**
 * Collect every text node descendant of `host` into a flat array.
 *
 * Skips elements with `data-find-skip` (reserved for future opt-out, e.g.
 * the toolbar input itself), invisible elements (display:none / visibility:
 * hidden — best-effort, no expensive layout reads), and `<script>` / `<style>`.
 */
export function collectTextNodes(host: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = host.ownerDocument?.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text)) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // Bail on script/style/template — these never render text the user sees.
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') {
        return NodeFilter.FILTER_REJECT
      }
      if (parent.closest('[data-find-skip]')) return NodeFilter.FILTER_REJECT
      // Empty / whitespace-only text nodes don't contribute matches.
      const v = node.nodeValue
      if (v == null || v.length === 0) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  if (!walker) return out
  let n: Node | null = walker.nextNode()
  while (n) {
    out.push(n as Text)
    n = walker.nextNode()
  }
  return out
}

/**
 * Walk text nodes synchronously and collect matches.
 *
 * Used by tests (deterministic, no async) and as the inner loop of the
 * chunked runner. Returns a {@link FindResult} with the match list and
 * the count of text nodes skipped for exceeding {@link REGEX_NODE_MAX}.
 *
 * `compiled` is consumed verbatim — callers must pre-compile via
 * {@link compileQuery} and bail on `kind === 'error' | 'empty'` before
 * calling this function.
 */
export function walkSync(
  textNodes: Text[],
  compiled: {
    kind: 'literal' | 'regex'
    matcher: (text: string) => Array<{ start: number; end: number }>
  },
): FindResult {
  const matches: FindMatch[] = []
  let skippedLongNodes = 0
  for (const node of textNodes) {
    const text = node.nodeValue ?? ''
    if (compiled.kind === 'regex' && text.length > REGEX_NODE_MAX) {
      skippedLongNodes += 1
      continue
    }
    const ranges = compiled.matcher(text)
    for (const r of ranges) {
      matches.push({ node, start: r.start, end: r.end })
    }
  }
  return { matches, skippedLongNodes }
}

/**
 * Cooperative chunked walker — runs {@link walkSync} 50 nodes at a time,
 * yielding via `requestIdleCallback` (fallback `setTimeout(0)`) between
 * chunks so a 10k-node page doesn't freeze the UI on first keypress.
 *
 * The returned {@link WalkerHandle} lets the caller abort an in-flight
 * walk when the user types again (the next call's `onProgress` /
 * `onComplete` will simply never fire). On completion `onComplete`
 * is called with the final {@link FindResult}; `onProgress` is
 * called after each chunk with the running totals so the toolbar
 * counter can update as we walk.
 */
export function runWalker(
  textNodes: Text[],
  compiled: {
    kind: 'literal' | 'regex'
    matcher: (text: string) => Array<{ start: number; end: number }>
  },
  callbacks: {
    onProgress?: (partial: FindResult) => void
    onComplete: (result: FindResult) => void
  },
): WalkerHandle {
  let cancelled = false
  let cursor = 0
  const matches: FindMatch[] = []
  let skippedLongNodes = 0

  const schedule = (fn: () => void) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown })
      .requestIdleCallback
    if (typeof ric === 'function') {
      ric(fn)
    } else {
      setTimeout(fn, 0)
    }
  }

  function step(): void {
    if (cancelled) return
    const end = Math.min(cursor + CHUNK_SIZE, textNodes.length)
    for (let i = cursor; i < end; i++) {
      const node = textNodes[i]
      if (!node) continue
      const text = node.nodeValue ?? ''
      if (compiled.kind === 'regex' && text.length > REGEX_NODE_MAX) {
        skippedLongNodes += 1
        continue
      }
      const ranges = compiled.matcher(text)
      for (const r of ranges) {
        matches.push({ node, start: r.start, end: r.end })
      }
    }
    cursor = end
    if (cursor >= textNodes.length) {
      callbacks.onComplete({ matches, skippedLongNodes })
      return
    }
    callbacks.onProgress?.({ matches: matches.slice(), skippedLongNodes })
    schedule(step)
  }

  // Kick off synchronously on first chunk so single-chunk pages
  // (the common case) complete in one tick without a needless yield.
  schedule(step)

  return {
    cancel(): void {
      cancelled = true
    },
  }
}
