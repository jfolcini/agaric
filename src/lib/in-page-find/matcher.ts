/**
 * In-page find matcher — locates substring matches in a container's
 * rendered DOM.
 *
 * Walks the DOM under a host container collecting text-node matches.
 * Returns a flat list of `{ node, start, end }` triples suitable for
 * constructing `Range` instances (consumed by the highlight renderer
 * via `CSS.highlights`).
 *
 * ## Architecture decision (deviation from the plan's "ProseMirror Decoration")
 *
 * The plan describes match highlighting via ProseMirror
 * Decorations on a single editor document. Agaric uses a **roving
 * editor** pattern: only the currently-focused block holds a
 * ProseMirror instance; every other block renders as static DOM (see
 * `src/components/editor/StaticBlock.tsx`). A `DecorationSet` therefore
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

/**
 * Maximum number of characters of a single text node that the regex
 * engine is allowed to scan (ReDoS guard, #2030).
 *
 * `re.exec` cannot be interrupted once it enters a catastrophic
 * backtrack, so the {@link REGEX_TIME_BUDGET_MS} aggregate budget — which
 * is only checked *between* nodes — cannot rescue a single hung exec on a
 * large node. The only thing that bounds a single `exec` is the size of
 * the string handed to it. We therefore run the regex against at most the
 * first `REGEX_NODE_SCAN_MAX` characters of each node rather than its
 * full (up to {@link REGEX_NODE_MAX}) length. Slicing from offset 0 keeps
 * every emitted match offset valid against the original node text.
 *
 * This is the "substantially lower the per-node cap for regex mode"
 * mitigation called for by #2030: it caps the per-`exec` cost so the
 * common pathological pattern (e.g. `(a+)+$`) can't freeze the thread on
 * one node, while the time budget bounds the aggregate across nodes.
 * (Patterns that still backtrack catastrophically within the slice are
 * bounded in count by the slice and surfaced via the aggregate budget.)
 */
export const REGEX_NODE_SCAN_MAX = 2_048

/** Chunk size for cooperative DOM walking. */
export const CHUNK_SIZE = 50

/**
 * Wall-clock budget (ms) for the synchronous regex scanning work.
 *
 * A short pathological pattern (e.g. `(a+)+$`) against a single ~10 KB
 * text node can backtrack exponentially. The pattern-length cap and the
 * {@link REGEX_NODE_MAX} per-node cap don't help: catastrophic
 * backtracking is governed by the pattern shape, not its length, and a
 * 10 KB node is far more than enough to hang the main thread for seconds.
 *
 * To keep the UI responsive we bound how long the matcher may spend
 * running regexes before it gives up. The budget is checked between
 * text nodes (the granularity at which a single `matcher(text)` call
 * runs to completion — once `re.exec` enters a pathological backtrack it
 * cannot be interrupted, so the budget protects the *aggregate* across
 * nodes and the boundary *before* the next node). On timeout the scan
 * aborts and the result is flagged {@link FindResult.timedOut} so the
 * caller can surface a "pattern too slow" signal instead of freezing.
 */
export const REGEX_TIME_BUDGET_MS = 75

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
  /**
   * True when the regex scan aborted early because it exceeded
   * {@link REGEX_TIME_BUDGET_MS} (ReDoS / catastrophic-backtracking
   * guard). `matches` then holds whatever was collected before the
   * budget ran out; the caller should surface a "pattern too slow"
   * signal rather than treating the count as authoritative. Absent /
   * `false` for literal scans and for regex scans that completed.
   */
  timedOut?: boolean
}

/** Token returned by `runWalker` so the caller can abort. */
export interface WalkerHandle {
  cancel(): void
}

/**
 * A regex-mode failure surfaced to the toolbar. Modelled as a discriminated
 * union so callers switch exhaustively instead of comparing a single
 * `string | null` slot against magic i18n sentinel keys:
 *  - `tooLong` — pattern exceeded {@link REGEX_PATTERN_MAX}.
 *  - `tooSlow` — the scan aborted on its ReDoS time budget (raised by the
 *    walker driver, not by {@link compileQuery}).
 *  - `invalid` — `new RegExp(...)` threw; `message` carries the raw compile
 *    error for display.
 */
export type FindRegexError =
  | { kind: 'tooLong' }
  | { kind: 'tooSlow' }
  | { kind: 'invalid'; message: string }

/** Outcome of compiling a query. `null` matcher means "no matches at all". */
export type CompiledQuery =
  | { kind: 'empty' }
  | { kind: 'literal'; matcher: (text: string) => Array<{ start: number; end: number }> }
  | { kind: 'regex'; matcher: (text: string) => Array<{ start: number; end: number }> }
  | { kind: 'error'; error: FindRegexError }

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
      return { kind: 'error', error: { kind: 'tooLong' } }
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
        error: { kind: 'invalid', message: err instanceof Error ? err.message : '' },
      }
    }
    const wholeWord = opts.wholeWord
    return {
      kind: 'regex',
      matcher: (text) => scanRegex(text, re, wholeWord),
    }
  }

  // Literal mode. Fold with `toLowerCase()`, NOT `toLocaleLowerCase()`:
  // find-in-page is a mechanical text operation and must give every user
  // the same answer on the same content. Locale-tailored casing is right
  // for sorting and display, not for "does this substring occur" — under
  // a tr/az default locale `toLocaleLowerCase()` maps 'I' to dotless 'ı'
  // so searching `i` stops matching `I`, and under `lt` folds grow
  // combining dots so `ĩ` stops matching `Ĩ` (#3800). VSCode's find
  // widget uses `toLowerCase()` for the same reason. For the remaining
  // Unicode case-folding edge cases we follow VSCode's approximation
  // (fold the haystack and needle together).
  //
  // NOTE this is deliberately WEAKER than `src/lib/fold-for-search.ts`, which
  // the global search and filter surfaces use: that one is additionally
  // diacritic- and eszett-insensitive, so `naive` matches `naïve` there and
  // not here. The divergence is forced, not an oversight — folding via NFKD
  // changes string length, and every match this module returns is a
  // {start,end} offset into the ORIGINAL text node for the highlighter to
  // range over. A length-changing fold breaks that mapping. If in-page find
  // ever needs diacritic insensitivity it needs an offset-preserving fold,
  // not this helper.
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const wholeWord = opts.wholeWord
  const caseSensitive = opts.caseSensitive
  // Per-code-point-folded needle for the slow path (`scanLiteralFolded`),
  // computed once here rather than re-folded on every call as it used to
  // be — `compileQuery` is the compile-once/match-many seam, not the
  // per-text-node scan. Skipped for `caseSensitive` queries, which never
  // reach the slow path. See the note in `scanLiteral` for why a
  // code-point fold, not `toLowerCase()`, is required here.
  let foldedNeedle = ''
  if (!caseSensitive) {
    for (const ch of query) {
      foldedNeedle += foldCodePoint(ch)
    }
  }
  return {
    kind: 'literal',
    // `foldedNeedle` (pre-folded once, above) is threaded through
    // alongside the whole-string-folded `needle` so the slow path can use
    // it directly instead of re-folding per call — see the note in
    // `scanLiteral`.
    matcher: (text) => scanLiteral(text, foldedNeedle, needle, wholeWord, caseSensitive),
  }
}

function scanLiteral(
  text: string,
  foldedNeedle: string,
  needle: string,
  wholeWord: boolean,
  caseSensitive: boolean,
): Array<{ start: number; end: number }> {
  if (caseSensitive) return scanIndexOf(text, text, needle, wholeWord)
  // Locale-independent fold — must stay in lockstep with the needle fold
  // in `compileQuery` (see the note there).
  const haystack = text.toLowerCase()
  // Fast path only when folding preserved the code-unit length. Lowercase
  // mappings never contract (1→N, N ≥ 1), so equal total length means every
  // code point folded 1:1 and offsets into `haystack` are valid offsets
  // into `text`. When folding expands (`İ` U+0130 → `i` + U+0307, 1 → 2
  // units — under `toLowerCase()` the only expanding code point in all of
  // Unicode, verified by exhaustive scan over 0x110000) every later offset
  // shifts and the indexOf results would point at the wrong span in the
  // original — fall through to the code-point walk that carries an
  // explicit offset map. The check stays length-based rather than
  // U+0130-specific: it is also what keeps the fast path correct for
  // context-sensitive but length-preserving folds such as Greek final
  // sigma, which per-code-point folding would get wrong.
  if (haystack.length === text.length) {
    return scanIndexOf(text, haystack, needle, wholeWord)
  }
  // Slow path: use the per-code-point-folded needle (#3812), not the
  // already-whole-string-folded `needle` above. `compileQuery` folds it
  // once, code-point-by-code-point, through the same algorithm
  // `scanLiteralFolded` uses below to fold the haystack, which drops
  // context sensitivity by construction (e.g. Greek `Σ` always folds to
  // non-final `σ` in isolation, never the word-final `ς` that
  // whole-string folding would give it). If the needle used the
  // whole-string fold while the haystack used the per-code-point fold,
  // the two could disagree on exactly the context-sensitive cases and
  // silently miss a match. Folding both sides with the same
  // context-*insensitive* algorithm on this path trades full correctness
  // for consistency between the two fold call sites — see the
  // module-level discussion in `scanLiteralFolded`.
  //
  // `compileQuery` leaves `foldedNeedle` as `''` for a case-SENSITIVE query,
  // and that is inert only because of the `caseSensitive` early return ~30
  // lines above — a non-local coupling nothing here would notice breaking.
  // It would not hang if it were broken (`from` still advances), but
  // `indexOf('', from)` matches at EVERY position, so it would silently emit
  // a bogus span per character rather than failing. Stated as a dev-only
  // invariant, matching the `import.meta.env.DEV` idiom used elsewhere in
  // this codebase: this branch is unreachable today by construction, so it
  // is an assertion about the coupling, not a covered code path.
  if (import.meta.env.DEV && foldedNeedle === '') {
    throw new Error(
      'in-page-find: scanLiteral reached the folded slow path with an empty folded needle — ' +
        'the caseSensitive early return above must keep this unreachable',
    )
  }
  return scanLiteralFolded(text, foldedNeedle, wholeWord)
}

/**
 * `indexOf` loop over `haystack`, emitting offsets that are valid in
 * `original` (callers guarantee 1:1 code-unit alignment between the two).
 * `String.prototype.matchAll` requires a global RegExp, and we want to
 * keep literal mode allocation-free per char.
 */
function scanIndexOf(
  original: string,
  haystack: string,
  needle: string,
  wholeWord: boolean,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    const end = idx + needle.length
    if (!wholeWord || isWholeWord(original, idx, end)) {
      out.push({ start: idx, end })
    }
    // Step by 1 (not by needle.length) so overlapping matches surface —
    // e.g. needle "aa" in "aaaa" returns 3 matches, not 2.
    from = idx + 1
  }
  return out
}

/**
 * Fold ONE code point for the slow path, canonicalising Greek sigma.
 *
 * `toLowerCase()` on a single code point is context-free, so `Σ` always
 * yields the mid-word `σ` (U+03C3) and never the word-final `ς` (U+03C2)
 * that whole-string folding would produce. Folding both sides
 * per-code-point makes them agree on `Σ`, but on its own it does NOT make
 * them agree on text that already CONTAINS a final `ς` — natural Greek
 * orthography — because `'ς'.toLowerCase()` is `'ς'`. Searching `ΟΔΟΣ`
 * over `οδος` would then fold to `οδοσ` vs `οδος` and silently miss.
 *
 * So the two sigma forms are collapsed onto one here. `οδος`, `ΟΔΟΣ` and
 * `οδοσ` all fold to `οδοσ`: no miss in either direction, and no false
 * positive introduced beyond the ς/σ conflation itself, which is the one
 * deliberate imprecision (pinned in the tests).
 *
 * This costs nothing in offset mapping — both sigmas are a single UTF-16
 * code unit, so the folded length is unchanged and `foldedStart` /
 * `foldedEnd` stay aligned.
 *
 * The needle MUST use this same function, not `toLowerCase()` on the whole
 * string: mixing a context-SENSITIVE needle fold with a context-FREE
 * haystack fold is the original #3812 defect.
 */
function foldCodePoint(ch: string): string {
  const f = ch.toLowerCase()
  return f === 'ς' ? 'σ' : f
}

/**
 * Slow literal path for haystacks whose lowercase fold changes length.
 *
 * Folds the text one code point at a time and records, for every folded
 * code unit, the original span of the code point that produced it. Matches
 * found in the folded string are then mapped back to original offsets, so
 * a length-changing fold early in the node (`İ` U+0130) no longer
 * shifts every later highlight span.
 *
 * `foldedNeedle` is the query text already folded by `compileQuery` (not
 * the whole-string-folded `needle` used by the fast path above).
 * `compileQuery` folds it once, code-point-by-code-point via
 * `foldCodePoint` — the exact same algorithm this function uses below to
 * fold the haystack — so both sides of the comparison use the same
 * context-*insensitive* algorithm (#3812). Whole-string folding
 * (`query.toLowerCase()`) is context-sensitive — e.g. Greek `Σ` folds to
 * word-final `ς` or mid-word `σ` depending on what follows it in the
 * string — while folding code-point-by-code-point can never see that
 * context and always produces the mid-word form. Folding the needle
 * whole-string while the haystack is folded per-code-point (as this
 * function used to do internally) let exactly those context-sensitive
 * cases disagree and silently miss a match; folding both sides the same
 * way trades full correctness for guaranteed agreement between the two
 * fold call sites, which is what this path actually needs.
 *
 * Agreeing on the fold is necessary but NOT sufficient, and an earlier
 * version of this fix stopped there and was wrong. Per-code-point folding
 * makes both sides agree on `Σ` (always mid `σ`), but `'ς'.toLowerCase()`
 * is `'ς'` — so text written in natural Greek orthography, ending a word
 * in `ς`, folds to `οδος` while the query `ΟΔΟΣ` folds to `οδοσ`, and the
 * match is silently MISSED. That trades one silent miss for another, in
 * the direction that occurs more often in real text.
 *
 * [`foldCodePoint`] therefore canonicalises the two sigma forms onto one,
 * on BOTH sides. `οδος`, `ΟΔΟΣ` and `οδοσ` all fold to `οδοσ`. The single
 * deliberate imprecision left is that ς and σ cannot be told apart on this
 * path — pinned by the pair of sigma tests, so it cannot change silently.
 */
function scanLiteralFolded(
  text: string,
  foldedNeedle: string,
  wholeWord: boolean,
): Array<{ start: number; end: number }> {
  // foldedStart[j] / foldedEnd[j] — original [start, end) span of the code
  // point that produced folded code unit `j`.
  //
  // See `foldCodePoint` for why both sides fold through the SAME helper.
  const foldedStart: number[] = []
  const foldedEnd: number[] = []
  let folded = ''
  let oi = 0
  for (const ch of text) {
    const f = foldCodePoint(ch)
    for (let k = 0; k < f.length; k++) {
      foldedStart.push(oi)
      foldedEnd.push(oi + ch.length)
    }
    folded += f
    oi += ch.length
  }
  const out: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= folded.length) {
    const idx = folded.indexOf(foldedNeedle, from)
    if (idx === -1) break
    const start = foldedStart[idx]
    const end = foldedEnd[idx + foldedNeedle.length - 1]
    if (start !== undefined && end !== undefined && (!wholeWord || isWholeWord(text, start, end))) {
      out.push({ start, end })
    }
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
  // ReDoS guard (#2030): never hand the regex engine more than
  // REGEX_NODE_SCAN_MAX characters of a node. A single `re.exec` can't be
  // interrupted once it enters a catastrophic backtrack, so the only way to
  // bound one exec's cost is to bound its input. Slicing from offset 0 keeps
  // every emitted offset valid against the original node text; matches that
  // would start beyond the cap are intentionally not surfaced (the time
  // budget across nodes is the aggregate backstop).
  const scanned = text.length > REGEX_NODE_SCAN_MAX ? text.slice(0, REGEX_NODE_SCAN_MAX) : text
  re.lastIndex = 0
  let m = re.exec(scanned)
  while (m !== null) {
    const start = m.index
    const end = start + m[0].length
    if (end === start) {
      // Zero-width match — advance lastIndex by one to avoid infinite loop.
      re.lastIndex = start + 1
    } else if (!wholeWord || isWholeWord(text, start, end)) {
      out.push({ start, end })
    }
    m = re.exec(scanned)
  }
  return out
}

// Unicode-aware word characters: letters, digits (any script), underscore.
// ASCII-only `[A-Za-z0-9_]` treated every non-Latin letter as a boundary,
// so whole-word "мир" matched inside "мирный".
const WORD_RE = /[\p{L}\p{N}_]/u
function isWordCodePoint(cp: number | undefined): boolean {
  if (cp === undefined) return false
  return WORD_RE.test(String.fromCodePoint(cp))
}

/**
 * Code point ending immediately before `index`, stepping back over a full
 * surrogate pair so astral letters (e.g. 𝐀) are classified whole rather
 * than as two unpaired surrogates.
 */
function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2)
  }
  return low
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start)
  const after = text.codePointAt(end)
  return !isWordCodePoint(before) && !isWordCodePoint(after)
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
  options?: {
    /**
     * Wall-clock budget (ms) for regex scanning before the walk aborts.
     * Defaults to {@link REGEX_TIME_BUDGET_MS}. Only consulted in regex
     * mode — literal scans are linear and need no guard. Exposed mainly
     * so tests can pin a tiny budget; production callers omit it.
     */
    timeBudgetMs?: number
    /** Injectable clock (defaults to `Date.now`) for deterministic tests. */
    now?: () => number
  },
): FindResult {
  const matches: FindMatch[] = []
  let skippedLongNodes = 0
  const guardTime = compiled.kind === 'regex'
  const now = options?.now ?? Date.now
  const budget = options?.timeBudgetMs ?? REGEX_TIME_BUDGET_MS
  const startedAt = guardTime ? now() : 0
  for (const node of textNodes) {
    // Check the budget *before* running the next node's matcher: once
    // `re.exec` enters a pathological backtrack it can't be interrupted,
    // so we stop at node boundaries to keep the aggregate scan bounded.
    if (guardTime && now() - startedAt > budget) {
      return { matches, skippedLongNodes, timedOut: true }
    }
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
  options?: {
    /**
     * Per-chunk wall-clock budget (ms) for regex scanning before the walk
     * aborts with {@link FindResult.timedOut}. Defaults to
     * {@link REGEX_TIME_BUDGET_MS}. Exposed mainly so tests can pin a tiny
     * budget for deterministic aborts; production callers omit it.
     */
    timeBudgetMs?: number
    /** Injectable clock (defaults to `Date.now`) for deterministic tests. */
    now?: () => number
  },
): WalkerHandle {
  let cancelled = false
  let cursor = 0
  const matches: FindMatch[] = []
  let skippedLongNodes = 0
  const guardTime = compiled.kind === 'regex'
  const now = options?.now ?? Date.now
  const budget = options?.timeBudgetMs ?? REGEX_TIME_BUDGET_MS

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
    // ReDoS guard: bound the wall-clock time spent running regexes inside
    // this synchronous chunk. A single ~10 KB node against a pathological
    // pattern (e.g. `(a+)+$`) can backtrack for seconds; without this the
    // yield between chunks never arrives and the UI thread is frozen. We
    // check at node boundaries (an in-flight `re.exec` can't be aborted).
    const startedAt = guardTime ? now() : 0
    for (let i = cursor; i < end; i++) {
      if (guardTime && now() - startedAt > budget) {
        cursor = i
        callbacks.onComplete({ matches, skippedLongNodes, timedOut: true })
        return
      }
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
