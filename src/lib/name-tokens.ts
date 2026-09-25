/**
 * The name tokens the text surfaces resolve: `[[Page]]` links, `#tag` and
 * `#[[multi word]]` tags (#5160 N1, N3). The rules are the backend's
 * (`collect_inbound_page_link_bodies` / `collect_inbound_tag_names` in
 * `src-tauri/src/commands/pages/markdown.rs`), and both sides are pinned to the
 * same rows of `conformance/reference-tokens.vectors.json` by
 * `reference-tokens-conformance.test.ts`. The Tauri mock resolves names
 * through this scan; the editor's typed-tag rule (Phase 3c) reads the same
 * predicates.
 *
 * A token is not a token when it is inside inline code, escaped by an odd run
 * of backslashes, or, for a tag, inside a bare URL, a link destination or a
 * `[[…]]` link; a `#name` is a tag only when the name holds a non-digit and
 * the `#` follows a boundary, which `&` and `[` are not.
 *
 * A link body splits on its first `|` into the name and a label (#5160 D9),
 * and Logseq's `[label]([[Page]])` is the same token. That split is what the
 * body reads as when no longer reading names a page (D10): the resolver tries
 * `linkBodyReadings` first.
 */

export interface TagToken {
  kind: 'tag'
  /** `[start, end)` of the whole token in the content, in UTF-16 units. */
  start: number
  end: number
  /** The trimmed name the token resolves. */
  name: string
}

export interface PageToken {
  kind: 'page'
  /** `[start, end)` of the whole token in the content, in UTF-16 units. */
  start: number
  end: number
  /**
   * The trimmed name before the body's first `|`, which the token resolves
   * when no longer reading of the body names a page (#5160 D10).
   */
  name: string
  /** The trimmed label after that `|`, when there is one. */
  label?: string
  /** The trimmed body, `Page|label` for Logseq's form. */
  body: string
}

export type NameToken = TagToken | PageToken

type Span = [start: number, end: number]

const PAGE_LINK_RE = /\[\[([^\]\n]+?)\]\]/g
const MULTIWORD_TAG_RE = /#\[\[([^\]\n]+?)\]\]/g
/** `HUMAN_TAG_RE`: group 1 the boundary (empty at the start), group 2 the name. */
// content-regex-allow: a compile-time constant; the first-char class omits `\p{M}` on purpose, as the Rust twin does (#3367): a name starts on a base character, and marks follow one
const BARE_TAG_RE = /(^|[^\p{L}\p{N}\p{M}_&[])#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_/-]*)/gu
/** `TAG_GUARD_RE`: a bare URL up to whitespace, or a link destination. */
const TAG_GUARD_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|\]\([^)\n]*\)/g
/** A canonical `[[ULID]]` body, which is already a ref and resolves nothing. */
const ULID_RE = /^[0-9A-Z]{26}$/
/** `LOGSEQ_LABELLED_LINK_RE`'s head, `[label](`, ending right before a `[[…]]` link. */
const LOGSEQ_LABEL_HEAD_RE = /\[([^\]\n]*)\]\($/

/** Whether `#name` names a tag: the name holds a non-digit. */
export function isTagName(name: string): boolean {
  // content-regex-allow: a compile-time constant tested against a whole name already cut at its boundaries, not a splice of user prose
  return /[^\p{N}]/u.test(name)
}

/**
 * Rust's `str::trim`: Unicode `White_Space` off both ends. JS `trim()` differs
 * at both edges the vectors probe: it keeps U+0085 and strips U+FEFF.
 */
const trimWhiteSpace = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')

/** A link body read as a page name, with the label the rest of it shows. */
export interface LinkReading {
  name: string
  label?: string
}

/**
 * `link_body_readings`: the ways a link body reads as a name and a label, in
 * the order the name pass tries them (#5160 D10, exact title first): the whole
 * body with no label, then each prefix ending before a `|`, longest first,
 * labelled with the rest. Trimmed; an empty label is none. The last reading
 * splits on the first `|`.
 */
export function linkBodyReadings(body: string): LinkReading[] {
  const readings: LinkReading[] = [{ name: trimWhiteSpace(body) }]
  for (let at = body.length - 1; at >= 0; at -= 1) {
    if (body[at] !== '|') continue
    const name = trimWhiteSpace(body.slice(0, at))
    const label = trimWhiteSpace(body.slice(at + 1))
    readings.push(label === '' ? { name } : { name, label })
  }
  return readings
}

/** Whether the token at `pos` follows an odd run of backslashes. */
function isEscaped(content: string, pos: number): boolean {
  let run = 0
  for (let i = pos - 1; i >= 0 && content[i] === '\\'; i -= 1) run += 1
  return run % 2 === 1
}

/** `import::inline_code_spans`: backticks paired left to right, included. */
function inlineCodeSpans(content: string): Span[] {
  const spans: Span[] = []
  let open: number | null = null
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '`') continue
    if (open === null) open = i
    else {
      spans.push([open, i + 1])
      open = null
    }
  }
  return spans
}

function spansOf(re: RegExp, content: string): Span[] {
  return [...content.matchAll(re)].map((m) => [m.index, m.index + m[0].length])
}

const inSpan = (pos: number, spans: readonly Span[]): boolean =>
  spans.some(([start, end]) => pos >= start && pos < end)

/** The page token over `[start, end)` whose trimmed body is `body`, split on its first `|`. */
function pageToken(start: number, end: number, body: string): PageToken {
  const pipe = body.indexOf('|')
  if (pipe < 0) return { kind: 'page', start, end, name: body, body }
  const name = trimWhiteSpace(body.slice(0, pipe))
  const label = trimWhiteSpace(body.slice(pipe + 1))
  return label === ''
    ? { kind: 'page', start, end, name, body }
    : { kind: 'page', start, end, name, label, body }
}

/** Every page-link and tag token of `content`, in text order. */
export function scanNameTokens(content: string): NameToken[] {
  const tokens: NameToken[] = []
  const code = inlineCodeSpans(content)
  const guards = [...code, ...spansOf(TAG_GUARD_RE, content)]
  const links: Span[] = []
  const isToken = (start: number): boolean => {
    const before = content[start - 1]
    return !inSpan(start, code) && before !== '#' && before !== '!' && !isEscaped(content, start)
  }
  for (const m of content.matchAll(PAGE_LINK_RE)) {
    let start = m.index
    let end = start + m[0].length
    links.push([start, end])
    const inner = m[1] ?? ''
    const rawName = inner.split('|', 1)[0] ?? ''
    let body = trimWhiteSpace(inner)
    // Logseq's `[label]([[Page]])` is one token when its own `[` is one, read
    // as `[[Page|label]]`.
    const head = LOGSEQ_LABEL_HEAD_RE.exec(content.slice(0, start))
    if (head && content[end] === ')' && isToken(start - head[0].length)) {
      const logseqLabel = trimWhiteSpace(head[1] ?? '')
      if (logseqLabel !== '') body = `${body}|${logseqLabel}`
      start -= head[0].length
      end += 1
    } else if (!isToken(start)) continue
    // Untrimmed, as the backend's canonical regex reads the whole token: a
    // padded ULID is a human name.
    if (body === '' || ULID_RE.test(rawName)) continue
    tokens.push(pageToken(start, end, body))
  }
  for (const m of content.matchAll(MULTIWORD_TAG_RE)) {
    const start = m.index
    if (inSpan(start, guards) || isEscaped(content, start)) continue
    const name = trimWhiteSpace(m[1] ?? '')
    if (name !== '') tokens.push({ kind: 'tag', start, end: start + m[0].length, name })
  }
  for (const m of content.matchAll(BARE_TAG_RE)) {
    const hash = m.index + (m[1] ?? '').length
    const name = m[2] ?? ''
    if (inSpan(hash, guards) || inSpan(hash, links) || isEscaped(content, hash)) continue
    if (!isTagName(name)) continue
    tokens.push({ kind: 'tag', start: hash, end: hash + 1 + name.length, name })
  }
  return tokens.toSorted((a, b) => a.start - b.start)
}
