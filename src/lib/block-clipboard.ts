/**
 * Block-subtree ⇄ indented-markdown serialization (#913).
 *
 * The system clipboard carries plain text, so a block "copy" that preserves
 * structure (the Logseq / Workflowy / Roam standard) encodes the selected
 * blocks + their subtrees as an INDENTED markdown outline: one block per line,
 * each child indented under its parent by {@link INDENT_UNIT} spaces per level.
 * Paste reverses the encoding into a flat list of block specs with relative
 * parent/index pointers, which the store materializes into real blocks.
 *
 * This is deliberately a SEPARATE indentation grammar from
 * `editor/markdown-serializer.ts` (which converts ONE block's content
 * ⇄ ProseMirror JSON). A block's own content is single-line markdown; the
 * outline indentation here expresses the block TREE, not inline marks. Each
 * line's text is the block's raw `content` verbatim — we do not re-serialize
 * it, so refs/marks/headings round-trip untouched.
 */

import type { FlatBlock } from '@/lib/tree-utils'
import { buildIndexById, computeSelectionRoots, getDragDescendants } from '@/lib/tree-utils'

/** Spaces per indent level — the repo's outline convention (2-space indent). */
export const INDENT_UNIT = 2

/**
 * Sentinel standing in for a newline INSIDE a single block's content while it
 * travels through the line-oriented outline (#1439 Phase 2). The outline is one
 * line per block, but a pasted table / fenced code block is MULTI-LINE and must
 * stay ONE block; `outlineToIndentedMarkdown` (`src/editor/html-to-blocks.ts`)
 * encodes such a block's internal newlines as this sentinel, and
 * {@link parseIndentedMarkdown} decodes them back to `\n` per block.
 *
 * `U+0000` (NUL) never legitimately appears in pasted clipboard text or in the
 * outline our copy/serialize path emits, so the decode is a NO-OP for every
 * existing caller (block copy, duplicate, context-menu paste) — only the
 * HTML-paste multi-line blocks carry it.
 */
export const OUTLINE_NEWLINE_SENTINEL = '\u0000'

// ── Human-readable reference rendering (export/clipboard only, #1440) ─────────

/**
 * Inline reference-token regexes. These mirror the canonical patterns the
 * markdown serializer EMITS (`src/editor/markdown-serialize.ts`) and the Rust
 * page-export resolver consumes (`src-tauri/agaric-store/src/cache/mod.rs`:
 * `TAG_REF_RE` / `PAGE_LINK_RE`, plus the `((ULID))` block-ref delimiter).
 * ULIDs are always 26 uppercase Crockford-base32 chars in canonical form, so
 * the character class is intentionally `[0-9A-Z]` (no lowercase).
 *
 * Kept verbatim-aligned with the Rust regexes so the clipboard/copy rendering
 * is byte-identical to what page-export produces for `#[ULID]` and `[[ULID]]`.
 */
const TAG_REF_RE = /#\[([0-9A-Z]{26})\]/g
const PAGE_LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
const BLOCK_REF_RE = /\(\(([0-9A-Z]{26})\)\)/g

/**
 * Rust's `char::is_whitespace` / `str::trim` use Unicode's `White_Space`
 * property. JavaScript's `\s` / `String.trim()` are subtly different: they
 * omit U+0085 (NEXT LINE) and include U+FEFF (BOM). Keep both export detection
 * and import edge-trimming on the explicit property so clipboard and Rust
 * markdown import/export stay byte-for-byte aligned.
 */
const UNICODE_WHITE_SPACE_RE = /\p{White_Space}/u
const UNICODE_WHITE_SPACE_EDGES_RE = /^\p{White_Space}+|\p{White_Space}+$/gu

function trimUnicodeWhiteSpace(value: string): string {
  return value.replace(UNICODE_WHITE_SPACE_EDGES_RE, '')
}

/**
 * Resolve an internal-reference ULID to a human-readable name for export.
 *
 * Returns the display name (page title / tag name / block snippet) when the
 * ULID is known, or `undefined` when it is not — a `undefined` (dangling)
 * result tells {@link humanizeRefTokens} to fall back to the opaque ULID form,
 * so a broken/cross-space reference is never dropped or made to crash.
 */
export type RefResolver = (ulid: string) => string | undefined

/**
 * Rewrite the opaque-ULID reference tokens in a single block's content into
 * the human-readable forms used by page-export (#1440):
 *
 *   `#[ULID]`  → `#tag` / `#[[Tag Name]]` (tag reference)
 *   `[[ULID]]` → `[[Page Name]]`          (block/page link)
 *   `((ULID))` → `((Name))`               (block reference)
 *
 * Resolution REUSES the same name source page-export uses (the title/tag
 * resolver) via the injected {@link RefResolver}; this function only renders.
 *
 * A ULID the resolver cannot resolve (a dangling ref, or a block-ref target
 * whose content isn't cached — page-export likewise leaves those verbatim)
 * falls back GRACEFULLY to the original ULID token, exactly like the Rust
 * `resolve_ulids_for_export` "keep original if not found" branch. Nothing is
 * dropped and no exception is thrown.
 *
 * This is a pure rendering pass over an EXPORT copy of the content; the stored
 * canonical block content (ULID-based) is never mutated.
 */
export function humanizeRefTokens(content: string, resolve: RefResolver): string {
  // Tag refs first, then page links, then block refs — the three token shapes
  // are disjoint, so ordering is immaterial for correctness; it just mirrors
  // the Rust resolver's tag→page sequence for readability.
  return content
    .replace(TAG_REF_RE, (match, ulid: string) => {
      const name = resolve(ulid)
      if (name === undefined) return match
      return UNICODE_WHITE_SPACE_RE.test(name) ? `#[[${name}]]` : `#${name}`
    })
    .replace(PAGE_LINK_RE, (match, ulid: string) => {
      const name = resolve(ulid)
      return name === undefined ? match : `[[${name}]]`
    })
    .replace(BLOCK_REF_RE, (match, ulid: string) => {
      const name = resolve(ulid)
      return name === undefined ? match : `((${name}))`
    })
}

// ── Human-readable reference resolution (import/paste only, #1484) ────────────

/**
 * A canonical 26-char Crockford-base32 ULID (uppercase). Used to recognise a
 * reference token that is ALREADY in internal/canonical form so the import
 * resolver leaves it untouched (an internal duplicate→paste round-trip serializes
 * `[[ULID]]`/`#[ULID]` with NO humanize resolver, so its tokens carry ULIDs, not
 * names — they must NOT be treated as a page/tag NAME to look up).
 */
const ULID_BODY_RE = /^[0-9A-Z]{26}$/

/**
 * Human-readable page/block link on the way IN: `[[Some Page]]`. The body is
 * any run of chars that is NOT `]` (so the `]]` close is unambiguous) and NOT a
 * bare ULID (handled verbatim — see {@link ULID_BODY_RE}). Non-greedy so
 * `[[A]] [[B]]` matches twice, not once across the gap.
 */
// #1920 — exported so the cross-language parity test
// (`src/lib/__tests__/page-link-re-parity.test.ts`) can assert it matches the
// SAME boundaries as the CANONICAL Rust `HUMAN_PAGE_LINK_RE` in
// `src-tauri/src/commands/pages/markdown.rs`. The two MUST stay byte-for-byte
// identical; change both together.
export const HUMAN_PAGE_LINK_RE = /\[\[([^\]\n]+?)\]\]/g

/**
 * Human-readable multi-word tag on the way IN: `#[[Tag With Space]]`.
 * The page-link pass must ignore the nested `[[...]]`; this dedicated pass
 * resolves the trimmed body as a tag before the bare `#tag` pass runs.
 *
 * Mirrored by the canonical Rust `HUMAN_MULTIWORD_TAG_RE` in
 * `src-tauri/src/commands/pages/markdown.rs`; the shared reference-token
 * conformance fixture pins both implementations to the same boundaries.
 */
export const HUMAN_MULTIWORD_TAG_RE = /#\[\[([^\]\n]+?)\]\]/g

/**
 * Human-readable tag on the way IN: `#tag` / `#nested/tag`. The name is a run of
 * tag-name chars (Unicode letters/digits plus `_`, `-`, `/` for nested tags),
 * mirroring the hashtag + nested-namespace convention. A `#` immediately
 * followed by `[` is the CANONICAL `#[ULID]` form and is deliberately NOT
 * matched here (the `[^[\W]`-style first-char guard via the class excludes `[`),
 * so canonical tags survive an internal round-trip untouched. The leading
 * boundary (`(^|[^\w])`) stops `a#b` / `word#frag` from being read as a tag.
 */
const HUMAN_TAG_RE = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu

/** A half-open `[start, end)` offset range within a block's content. */
type Span = [number, number]

/** `true` when offset `pos` falls inside any of `spans`. */
const inSpans = (pos: number, spans: readonly Span[]): boolean =>
  spans.some(([start, end]) => pos >= start && pos < end)

/** Leading run of Rust-`White_Space` chars, i.e. Rust's `str::trim_start`. */
const LEADING_WHITE_SPACE_RE = /^\p{White_Space}+/u

/**
 * A line that OPENS or CLOSES a fenced code block, as the CANONICAL Rust
 * importer defines one (`is_fence_delim` in `agaric-engine/src/import.rs`):
 * the line, left-trimmed and with an optional `- ` bullet marker stripped,
 * starts with three backticks.
 *
 * DELIBERATELY backtick-only. The importer's fence detection is
 * `fence_probe.starts_with("```")` and nothing else, so a `~~~` fence is plain
 * text to Rust: it flags no block `is_code` and happily resolves a `#tag`
 * inside one. Accepting `~~~` here would protect a tag the importer rewrites —
 * a NEW divergence in the very passes #3599 exists to align. Tilde fences are
 * unsupported on BOTH sides; change the two together or not at all.
 */
const FENCE_DELIM_RE = /^(?:- )?```/

/** `true` when a left-trimmed line is an outline bullet (`-` or `- ...`). */
const BULLET_LINE_RE = /^-(?: |$)/

/**
 * #3599 — the ranges of ONE block's content that the CANONICAL Rust importer
 * would flag `is_code`, so the tag passes can treat them as literal text.
 *
 * The paste path can receive a whole code block as a single multi-line block
 * (the copy path encodes in-block newlines with
 * {@link OUTLINE_NEWLINE_SENTINEL}), whereas the importer's line-oriented
 * parser (`parse_logseq_markdown`, `agaric-engine/src/import.rs`) reaches the
 * same text as lines. Different mechanism, one observable contract — so this
 * mirrors the importer's own rules, each MEASURED against it rather than
 * assumed:
 *
 *   * `is_code` is a property of the whole BLOCK, not of the fenced lines. The
 *     importer folds every non-bullet continuation line into the preceding
 *     block and OR-s the flag across them, so a block that merely CONTAINS a
 *     fence is literal end to end — text before the opener and after the closer
 *     included. Protecting only the fenced lines would resolve a `#tag` the
 *     importer leaves alone.
 *   * a delimiter line is code itself (`line_is_code = in_fence || is_delim`).
 *   * a fence opener is `is_fence_delim`: left-trimmed, optional `- ` bullet
 *     marker stripped, starts with three backticks. Blank lines are skipped
 *     before any fence bookkeeping.
 *   * #2866 — an UNTERMINATED fence does not simply swallow the rest. A
 *     bullet-shaped line at or above the opener's depth force-closes it (and
 *     starts a fresh, non-code block) UNLESS the next non-blank line is a bare
 *     ```` ``` ````, which can only ever close an open fence and so marks this
 *     line as fence CONTENT.
 *   * #3617 — ANY bullet outside an open fence ends the block run, mirroring
 *     the importer pushing a new block for every bullet line regardless of
 *     fence state. The #2866 recovery point is the special case where the
 *     bullet also force-closes a dangling fence, not a separate mechanism.
 *
 * KNOWN, BOUNDED DIVERGENCE: the importer's `fence_open_depth` for a bare
 * opener is the depth of the previously emitted block; inside a single block's
 * content there is no such block, so the opener line's own indent depth stands
 * in. The two agree whenever the fence opens at the content's base indent,
 * which is the shape the copy path produces.
 *
 * OUT OF SCOPE: external markdown pasted as raw lines is split by
 * {@link parseIndentedMarkdown} into one block per line, so a three-line fence
 * arrives as three separate blocks and no single block's content ever contains
 * the fence — this helper sees nothing to protect and the importer's `is_code`
 * has no counterpart. Closing that shape needs fence tracking in the line
 * splitter itself, not here.
 */
function fencedCodeSpans(content: string): Span[] {
  if (!content.includes('```')) return []
  const lines = content.split('\n')
  // Absolute [start, end) of every line; `+ 1` steps over the consumed `\n`.
  const bounds: Span[] = []
  let offset = 0
  for (const line of lines) {
    bounds.push([offset, offset + line.length])
    offset += line.length + 1
  }
  const leftTrim = (line: string): string => line.replace(LEADING_WHITE_SPACE_RE, '')

  const spans: Span[] = []
  let inFence = false
  let openDepth = 0
  // The importer's block granularity: `runStart`..`runEnd` is the stretch of
  // content that lands in one block, `runHasCode` its OR-ed `is_code` flag.
  let runStart = 0
  let runEnd = 0
  let runHasCode = false
  const flushRun = (): void => {
    if (runHasCode && runEnd > runStart) spans.push([runStart, runEnd])
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = leftTrim(line)
    if (trimmed.length === 0) continue
    const isDelim = FENCE_DELIM_RE.test(trimmed)
    const depth = Math.floor((line.length - trimmed.length) / 2)
    const [lineStart, lineEnd] = bounds[i] ?? [content.length, content.length]

    // #2866 recovery, evaluated before the line is classified (as in Rust):
    // an ordinary bullet at/above the open fence's depth force-closes an
    // unterminated fence, unless the next non-blank line is a bare closing
    // delimiter. This only flips `inFence` back to false — ending the run at
    // this line is now the job of the general #3617 bullet check below, the
    // same as it is for any other bullet line.
    if (inFence && !isDelim && BULLET_LINE_RE.test(trimmed) && depth <= openDepth) {
      let peek = i + 1
      while (peek < lines.length && leftTrim(lines[peek] ?? '').length === 0) peek += 1
      // Past the end counts as "not a bare delimiter", matching the importer's
      // fall-through-to-recovery at EOF.
      if (!leftTrim(lines[peek] ?? '').startsWith('```')) inFence = false
    }

    const lineIsCode = inFence || isDelim
    if (isDelim) {
      if (!inFence) openDepth = depth
      inFence = !inFence
    }

    // #3617 — mirror the importer's per-line block boundary generally, not
    // only at the #2866 recovery point above: an ordinary bullet (`- ` or a
    // bare `-`) that is NOT itself fence content — i.e. not a line strictly
    // INSIDE an already-open fence — starts a NEW block, ending the current
    // run. A bullet whose own line opens/closes the fence (`- ```) still
    // counts, since `inCodeBody` is false for the delimiter line itself.
    const inCodeBody = inFence && !isDelim
    if (!inCodeBody && BULLET_LINE_RE.test(trimmed)) {
      flushRun()
      runStart = lineStart
      runEnd = lineStart
      runHasCode = false
    }

    if (lineIsCode) runHasCode = true
    runEnd = lineEnd
  }
  flushRun()
  return spans
}

/**
 * Inline-code-span ranges (`` `...` ``), an algorithmic mirror of the Rust
 * `inline_code_spans` helper in `src-tauri/src/commands/pages/markdown.rs`:
 * a simple left-to-right backtick pairing, with the backticks themselves inside
 * the range. (The offsets are UTF-16 units here and bytes there; only the
 * PAIRING must match, and each side's offsets are used solely against its own
 * string.) Deliberately NOT the full CommonMark run-length rule — the two
 * implementations must agree, and single-backtick pairing is what the importer
 * uses, so ` ``#tag`` ` resolves `tag` on BOTH sides. Offsets already covered by
 * `skip` (a fenced region) are ignored so the fence delimiters cannot pair into
 * bogus inline spans; Rust needs no such exclusion because its parser never
 * hands a fenced region to a non-`is_code` block.
 */
function inlineCodeSpans(content: string, skip: readonly Span[]): Span[] {
  const spans: Span[] = []
  let open: number | null = null
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '`' || inSpans(i, skip)) continue
    if (open === null) open = i
    else {
      spans.push([open, i + 1])
      open = null
    }
  }
  return spans
}

/**
 * #3598/#3599 — the PROTECTED ranges of a block's content for the tag passes:
 * fenced code regions plus inline-code spans. A `#tag` inside one is literal
 * text and is NEVER resolved (no page/tag is created for it) and NEVER
 * rewritten, matching the Rust importer's `is_code` + inline-code skips.
 */
function protectedCodeSpans(content: string): Span[] {
  const fenced = fencedCodeSpans(content)
  return [...fenced, ...inlineCodeSpans(content, fenced)]
}

/**
 * Resolve a human-readable reference NAME to its internal ULID on import,
 * CREATING the page/tag when it does not exist (#1484). Returns the ULID, or
 * `null` to leave the original token as plain text (an unresolvable/ambiguous
 * name — e.g. a duplicate page title under the leave-plain rule, or a creation
 * failure). May be async (creation routes through IPC).
 */
export type RefInternalizer = (name: string) => Promise<string | null>

/**
 * Injected resolvers for {@link internalizeRefTokens}. Each maps a
 * human-readable name to an internal ULID, creating the target if missing.
 * `block` is optional: `((Block Name))` has no by-name creation path, so when
 * omitted those tokens are left as plain text.
 */
export interface RefInternalizers {
  page: RefInternalizer
  tag: RefInternalizer
}

/**
 * Rewrite the human-readable reference tokens in a single block's content into
 * the internal ULID forms the editor stores/parses (#1484) — the inverse of
 * {@link humanizeRefTokens}:
 *
 *   `[[Page Name]]`  → `[[ULID]]`   (resolve title; create the page if missing)
 *   `#tag`           → `#[ULID]`     (resolve tag name; create the tag if missing)
 *   `#[[Tag Name]]`  → `#[ULID]`     (multi-word tag; trim Unicode White_Space)
 *   `((Block Name))` → left as plain text (no by-name block-ref creation path)
 *
 * A token already in canonical form (`[[ULID]]`, `#[ULID]`) is left untouched so
 * an internal duplicate→paste round-trip stays ULID-canonical. A name the
 * resolver returns `null` for (unresolvable / ambiguous duplicate title /
 * creation failure) is left as its original plain-text token — nothing is
 * dropped and no exception escapes (the caller's resolver owns error handling).
 *
 * Async because page/tag creation routes through IPC. Pure w.r.t. the input
 * string: it returns a rewritten COPY and never mutates `content`.
 */
export async function internalizeRefTokens(
  content: string,
  resolvers: RefInternalizers,
): Promise<string> {
  // Page links first, followed by multi-word and then bare tags. Both tag forms
  // share one cache, so `#[[Shared]] and #Shared` performs one tag resolution.
  const withPages = await replaceRefs(
    content,
    HUMAN_PAGE_LINK_RE,
    resolvers.page,
    (ulid) => `[[${ulid}]]`,
    { skipCanonicalBody: true, skipPagePrefixes: true, trimName: true },
  )
  const tagCache = new Map<string, string | null>()
  const withMultiwordTags = await replaceRefs(
    withPages,
    HUMAN_MULTIWORD_TAG_RE,
    resolvers.tag,
    (ulid) => `#[${ulid}]`,
    { trimName: true, resolved: tagCache, skipCodeSpans: true },
  )
  return replaceRefs(withMultiwordTags, HUMAN_TAG_RE, resolvers.tag, (ulid) => `#[${ulid}]`, {
    tagBoundary: true,
    resolved: tagCache,
    skipCodeSpans: true,
  })
}

interface ReplaceRefOptions {
  /** Group 1 is a leading boundary and group 2 is the name. */
  tagBoundary?: boolean
  /** Ignore `#[[tag]]` and `![[embed]]` candidates in the page-link pass. */
  skipPagePrefixes?: boolean
  /** Leave a canonical `[[ULID]]` page link untouched. Tags use token shape. */
  skipCanonicalBody?: boolean
  /** Normalize Rust Unicode White_Space at human-reference boundaries. */
  trimName?: boolean
  /** Cache shared by the multi-word and bare tag passes. */
  resolved?: Map<string, string | null>
  /**
   * #3599 — leave matches inside a PROTECTED code range (fenced code block or
   * inline-code span) alone: not resolved, not rewritten. Set on both tag
   * passes so they match the Rust importer, which skips `is_code` blocks
   * wholesale and inline-code spans within a block.
   */
  skipCodeSpans?: boolean
}

/**
 * Shared engine for {@link internalizeRefTokens}: find every NAME match of
 * `re`, resolve the distinct names once via `resolve`, then rebuild the string
 * with each resolved name rewritten via `render(ulid)`. A page name that is a
 * bare ULID (already canonical) or any name resolving to `null` keeps its token.
 * Tags determine canonicality from their token shape instead: `#[ULID]` never
 * matches a human tag regex, while `#ULID` and `#[[ULID]]` are human tag names.
 *
 * `options.tagBoundary` (bare tags only) means the regex captures a leading
 * boundary char in group 1 and the name in group 2; the boundary is re-emitted.
 * Page links and multi-word tags have the name in group 1.
 */
async function replaceRefs(
  content: string,
  re: RegExp,
  resolve: RefInternalizer,
  render: (ulid: string) => string,
  options: ReplaceRefOptions = {},
): Promise<string> {
  const { resolved = new Map<string, string | null>() } = options
  // In tag mode, a `#tag`-looking substring may live inside an UNRESOLVED
  // `[[Page Name]]` token that survived the page pass (e.g. `[[Project #alpha]]`).
  // Rewriting that `#alpha` would corrupt the link into `[[Project #[ULID]]]`,
  // so collect the `[[ ... ]]` spans and skip any tag match that falls inside one.
  // (Resolved links are already `[[ULID]]` and contain no `#`, so they're inert.)
  // NOTE: the spans below are computed against THIS pass's `content`. Each pass
  // rewrites tokens of a different length, so offsets move between passes and a
  // span list may never be carried over from an earlier one.
  const bracketSpans: Span[] = []
  if (options.tagBoundary) {
    for (const b of content.matchAll(HUMAN_PAGE_LINK_RE)) {
      bracketSpans.push([b.index, b.index + b[0].length])
    }
  }
  // #3599 — fenced/inline code ranges, in which a `#tag` is literal text.
  const codeSpans: Span[] = options.skipCodeSpans === true ? protectedCodeSpans(content) : []

  const matches = [...content.matchAll(re)]
  const candidate = (
    match: RegExpMatchArray,
  ): { boundary: string; name: string; rawName: string } => {
    const boundary = options.tagBoundary ? (match[1] ?? '') : ''
    const rawName = (options.tagBoundary ? match[2] : match[1]) ?? ''
    return {
      boundary,
      name: options.trimName ? trimUnicodeWhiteSpace(rawName) : rawName,
      rawName,
    }
  }
  const shouldSkip = (match: RegExpMatchArray, boundary: string): boolean => {
    const matchIndex = match.index ?? 0
    // The `#` of a tag match sits after its captured leading-boundary char
    // (empty for the multi-word pass, whose match starts at the `#`).
    const hashPos = matchIndex + boundary.length
    if (inSpans(hashPos, codeSpans)) return true
    if (options.tagBoundary && inSpans(hashPos, bracketSpans)) return true
    if (!options.skipPagePrefixes || matchIndex === 0) return false
    const prefix = content[matchIndex - 1]
    return prefix === '#' || prefix === '!'
  }
  const isCanonicalBody = (rawName: string): boolean =>
    options.skipCanonicalBody === true && ULID_BODY_RE.test(rawName)

  // Pass 1: collect distinct candidate names (skip bare-ULID canonical bodies,
  // tag matches inside `[[ ]]` or a protected code range, and page matches
  // owned by tags or embeds). Skipping here — not just in the rebuild below —
  // is what keeps the RESOLVER SIDE EFFECTS aligned with Rust: a protected
  // name is never even looked up, so no page/tag is created for it (#3599).
  const names = new Set<string>()
  for (const match of matches) {
    const { boundary, name, rawName } = candidate(match)
    if (shouldSkip(match, boundary)) continue
    if (name.length > 0 && !isCanonicalBody(rawName)) names.add(name)
  }
  if (names.size === 0) return content

  // Pass 2: resolve each distinct name once (create-if-missing), sequentially
  // so concurrent creation of the SAME name can't race into two pages/tags.
  for (const name of names) {
    if (resolved.has(name)) continue
    try {
      resolved.set(name, await resolve(name))
    } catch {
      resolved.set(name, null)
    }
  }

  // Pass 3: rebuild from the captured offsets. Using the same `shouldSkip`
  // predicate as collection prevents a resolved `Shared` page from rewriting
  // the `[[Shared]]` nested inside `#[[Shared]]` or `![[Shared]]`.
  let output = ''
  let cursor = 0
  for (const match of matches) {
    const matchIndex = match.index ?? 0
    output += content.slice(cursor, matchIndex)
    const { boundary, name, rawName } = candidate(match)
    if (shouldSkip(match, boundary) || isCanonicalBody(rawName)) {
      output += match[0]
      cursor = matchIndex + match[0].length
      continue
    }
    const ulid = resolved.get(name)
    output += ulid == null ? match[0] : boundary + render(ulid)
    cursor = matchIndex + match[0].length
  }
  return output + content.slice(cursor)
}

/**
 * A parsed clipboard block: its content and a pointer to its parent's index in
 * the SAME parsed list (`null` = top-level / paste root). Children always
 * appear AFTER their parent in document order, so a parent index is always
 * already resolved when a child references it.
 */
export interface ParsedBlock {
  content: string
  /** Index of the parent in the parsed array, or `null` for a top-level block. */
  parentIndex: number | null
}

// ── Serialize: block subtree → indented markdown ─────────────────────────────

/**
 * Serialize the selection ROOTS (+ their subtrees) to an indented-markdown
 * outline. `selectedIds` may contain blocks already nested inside other
 * selected blocks — {@link computeSelectionRoots} collapses those so each
 * subtree is emitted exactly once.
 *
 * Indentation is RELATIVE: the shallowest emitted block sits at indent 0 and
 * every other block is indented by `(depth - baseDepth)` levels, so copying a
 * deeply-nested selection pastes back at the top level with its internal
 * structure intact. Blocks are emitted in document order (their order in the
 * flat `items` list).
 *
 * Returns the empty string when nothing is selected / nothing matches.
 *
 * `humanize` (#1440) — optional reference renderer. When supplied, each block's
 * content has its opaque-ULID reference tokens rewritten to human-readable
 * names (`[[Page Name]]` / `#tag` / `((Name))`) via {@link humanizeRefTokens},
 * matching what page-export emits. This is for the SYSTEM-CLIPBOARD copy path
 * only; the internal copy→paste round-trips (duplicate, context-menu paste)
 * call WITHOUT it so block content stays ULID-canonical for re-import. Omitting
 * it preserves the original verbatim-content behaviour exactly.
 */
export function serializeBlockSubtree(
  items: FlatBlock[],
  selectedIds: Iterable<string>,
  humanize?: RefResolver,
): string {
  const roots = computeSelectionRoots(items, selectedIds)
  if (roots.length === 0) return ''

  // Collect each root + its descendants, preserving document order. A Set keeps
  // the emission idempotent if (defensively) a descendant is also a root.
  // Perf (#2041): build the `id → index` map ONCE and reuse it for every root's
  // `getDragDescendants`, so the per-root O(n) `findIndex` becomes O(1) (R×n →
  // R + n).
  const indexById = buildIndexById(items)
  const emit = new Set<string>()
  for (const rootId of roots) {
    emit.add(rootId)
    for (const descId of getDragDescendants(items, rootId, indexById)) emit.add(descId)
  }

  const emitted = items.filter((b) => emit.has(b.id))
  if (emitted.length === 0) return ''

  // Baseline = shallowest emitted depth, so the outline always starts at 0.
  const baseDepth = emitted.reduce((min, b) => Math.min(min, b.depth), Number.POSITIVE_INFINITY)

  return emitted
    .map((b) => {
      const indent = ' '.repeat(INDENT_UNIT * (b.depth - baseDepth))
      const content = b.content ?? ''
      return indent + (humanize ? humanizeRefTokens(content, humanize) : content)
    })
    .join('\n')
}

// ── Parse: indented markdown → block specs ───────────────────────────────────

/**
 * Measure a line's leading-space indentation in INDENT units (floored), and
 * return the content with that indentation stripped. Tabs are each counted as
 * one indent unit (a pragmatic stance — pasted outlines from other tools mix
 * tabs and spaces); any remaining leading whitespace stays in the content.
 */
function measureIndent(line: string): { level: number; content: string } {
  let spaces = 0
  let i = 0
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') spaces += 1
    else if (ch === '\t') spaces += INDENT_UNIT
    else break
  }
  return { level: Math.floor(spaces / INDENT_UNIT), content: line.slice(i) }
}

/**
 * Parse an indented-markdown outline into a flat list of {@link ParsedBlock}s
 * with relative parent pointers.
 *
 * The algorithm walks lines top-to-bottom keeping a stack of "open ancestor"
 * indices keyed by indent level. A line at level `L` becomes a child of the
 * most recent earlier line at level `< L` (clamped so a jump of >1 level does
 * not orphan it). Blank lines are skipped — they carry no block. Indentation
 * deeper than the current context is clamped to one level deeper than the
 * parent, so adversarial / hand-typed over-indentation can't create gaps in
 * the parent chain.
 *
 * Returns `[]` for empty / whitespace-only input — callers treat that as
 * "nothing recognizable" and fall back to a single-block paste.
 */
export function parseIndentedMarkdown(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  // `stack[level]` = index in `blocks` of the most recent block opened AT that
  // level. Truncated whenever we dedent so stale deeper entries can't be reused.
  const stack: number[] = []

  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue
    const { level: rawLevel, content: encodedContent } = measureIndent(rawLine)
    // Decode any in-block newline sentinel back to a real `\n` so a multi-line
    // table / code-fence block (#1439 Phase 2) is restored as one block's
    // multi-line content. A NO-OP for every other caller — the sentinel never
    // appears in copy/serialize output (see OUTLINE_NEWLINE_SENTINEL).
    const content = encodedContent.includes(OUTLINE_NEWLINE_SENTINEL)
      ? encodedContent.replaceAll(OUTLINE_NEWLINE_SENTINEL, '\n')
      : encodedContent
    // Clamp the level so a block can be at most one level deeper than the
    // deepest currently-open ancestor (no orphaning jumps).
    const level = Math.min(rawLevel, stack.length)

    const parentIndex = level > 0 ? (stack[level - 1] ?? null) : null
    const myIndex = blocks.length
    blocks.push({ content, parentIndex })

    // This block is now the open ancestor at its level; everything deeper is
    // closed (a later sibling/child re-opens as needed).
    stack.length = level
    stack[level] = myIndex
  }

  return blocks
}
