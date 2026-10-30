/**
 * Frontend half of the #1925 attachment-import detector.
 *
 * When importing a Logseq/Obsidian *vault* (a `webkitdirectory` folder pick),
 * the picked `FileList` carries every file in the chosen folder — including the
 * non-markdown assets the markdown references (images, pdfs, …). To pass only
 * the *referenced* sibling files over IPC (and avoid reading megabytes of
 * unreferenced assets), the importer pre-scans each markdown file for the
 * attachment references the BACKEND will try to match, then reads just those
 * matched files.
 *
 * {@link scanAttachmentRefs} is that pre-scan. It is a PURE function and the
 * frontend mirror of the Rust detector in `src-tauri/agaric-engine/src/import.rs`
 * (`detect_attachment_refs`, `is_skippable_attachment_ref`, `links_a_file`,
 * `link_destination`, `percent_decode`, the `OBSIDIAN_EMBED_RE` /
 * `MARKDOWN_LINK_OPEN_RE` regexes,
 * the fenced-code-block `is_code` skipping in `parse_logseq_markdown`, and
 * `inline_code_spans`).
 *
 * The FE scanner decides which sibling bytes to ship; the BE detector decides
 * which refs to rewrite. If the FE detects a ref the BE does not, we ship bytes
 * the BE ignores (a harmless waste). If the FE MISSES a ref the BE matches, the
 * BE warns about a missing vault file and leaves the ref un-rewritten. Both
 * sides' tests read `conformance/attachment-refs.vectors.json`, so a change to
 * either detector shows there.
 */

/**
 * Obsidian embed `![[file.png]]` — group 1 is the inner ref (path or basename:
 * any run of chars that is neither `]`, `|`, nor newline; the optional `|alt`
 * display suffix Obsidian allows is dropped). Non-greedy. Mirrors
 * `OBSIDIAN_EMBED_RE`.
 */
const OBSIDIAN_EMBED_RE = /!\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g

/**
 * The opening of a standard markdown image `![alt](` — group 1 is the alt text
 * — or of a link `[label](` — group 2 is the label, which holds no bracket, so
 * the image in `[![a](x.png)](doc.pdf)` is read and not the link.
 * {@link linkDestination} reads the rest of the token. Mirrors
 * `MARKDOWN_LINK_OPEN_RE`.
 */
const MARKDOWN_LINK_OPEN_RE = /!\[([^\]\n]*)\]\(|\[([^[\]\n]*)\]\(/g

/** A link's `<…>` destination, after any spaces. Mirrors `ANGLE_DESTINATION_RE`. */
const ANGLE_DESTINATION_RE = /[^\S\n]*<([^<>\n]*)>/y

/** Spaces before a bare destination. */
const SPACES_RE = /[^\S\n]*/y

/** A link's title: spaces, then `"…"`, `'…'` or `(…)`. Mirrors `LINK_TITLE_RE`. */
const LINK_TITLE_RE = /[^\S\n]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))/y

/** A link's closing `)`, after any spaces. Mirrors `LINK_CLOSE_RE`. */
const LINK_CLOSE_RE = /[^\S\n]*\)/y

/** The match of the sticky `re` at `at` in `text`, or null. */
function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(text)
}

/**
 * The destination of the markdown image or link whose `![alt](` or `[label](`
 * ends at `start` in `text`, and the index just past its closing `)`, read as
 * CommonMark reads a link destination: a `<…>` one, or a bare one running to
 * whitespace with its parentheses balanced, then an optional title. Null when
 * none closes there, as in `![](my image.png)`. Mirrors `link_destination`.
 */
function linkDestination(text: string, start: number): { destination: string; end: number } | null {
  let at = start
  let destination: string
  const angle = matchAt(ANGLE_DESTINATION_RE, text, at)
  if (angle !== null) {
    destination = angle[1] ?? ''
    at += angle[0].length
  } else {
    at += matchAt(SPACES_RE, text, at)?.[0].length ?? 0
    const bareStart = at
    let depth = 0
    for (; at < text.length; at++) {
      const c = text[at] as string
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      } else if (/\s/.test(c)) break
    }
    destination = text.slice(bareStart, at)
  }
  at += matchAt(LINK_TITLE_RE, text, at)?.[0].length ?? 0
  const close = matchAt(LINK_CLOSE_RE, text, at)
  return close === null ? null : { destination, end: at + close[0].length }
}

/** A run of `%XX` escapes. */
const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g

/** Keeps a decoded BOM, as Rust's `from_utf8_lossy` does. */
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * `%XX` escapes decoded to their bytes, read as UTF-8 (an invalid sequence as
 * U+FFFD); anything else, and a malformed escape, stays as written. Mirrors
 * `percent_decode`, which `decodeURIComponent` does not: it throws on a
 * malformed escape.
 */
function percentDecode(text: string): string {
  return text.replace(PERCENT_RUN_RE, (run) =>
    UTF8.decode(Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16))),
  )
}

/**
 * `true` when `reference` is one the import must NOT try to ingest as a vault
 * attachment: an absolute URL (`http://`, `https://`, `data:`), a
 * protocol-relative `//host` URL, or an already-canonical `attachment:<id>`
 * ref. Mirrors `is_skippable_attachment_ref`.
 */
function isSkippableAttachmentRef(reference: string): boolean {
  const r = reference.trim()
  return (
    r.startsWith('http://') ||
    r.startsWith('https://') ||
    r.startsWith('data:') ||
    r.startsWith('//') ||
    r.startsWith('attachment:')
  )
}

/**
 * The extensions a pick imports as pages, also the plain picker's `accept`
 * list: Markdown and text files are read as Markdown, an Org file through
 * `orgToMarkdown`. A link to one is a page link, never an attachment.
 */
export const NOTE_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.org'] as const

/**
 * Whether a link to the decoded `destination` may name a file the import
 * attaches: not a `#fragment`, nor a URL with a scheme, nor a note. Mirrors
 * `links_a_file`.
 */
function linksAFile(destination: string): boolean {
  const name = (destination.split(/[/\\]/).pop() ?? '').toLowerCase()
  return (
    !destination.startsWith('#') &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination) &&
    !NOTE_EXTENSIONS.some((ext) => name.endsWith(ext))
  )
}

/**
 * Byte-range (`[start, end)`) pairs covering inline-code spans (`` `...` ``) in
 * `content`. Single-backtick pairing — the same minimal rule the backend's
 * `inline_code_spans` uses. Ranges are over UTF-16 code-unit indices (JS string
 * indices), which is what the regex `lastIndex` is also measured in, so the two
 * agree within this function even though the Rust side measures bytes.
 */
function inlineCodeSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let open: number | null = null
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '`') {
      if (open === null) {
        open = i
      } else {
        spans.push([open, i + 1])
        open = null
      }
    }
  }
  return spans
}

/**
 * Strip the leading `- ` bullet marker (if any) before testing for a fence
 * delimiter — mirrors the backend's `fence_probe` (`- ```rust` is a fenced
 * bullet). Tabs are normalized to spaces first (the parser does the same), but
 * for fence detection we only need the trimmed-start text.
 */
function isFenceDelim(trimmedStart: string): boolean {
  const probe = trimmedStart.startsWith('- ') ? trimmedStart.slice(2) : trimmedStart
  return probe.startsWith('```')
}

/**
 * Lines that fall inside (or open/close) a ```` ``` ````-fenced code region.
 *
 * Mirrors the MINIMAL `#1924` fence tracking in `parse_logseq_markdown`: a line
 * whose trimmed-start text (after optionally stripping a `- ` bullet) begins
 * with three backticks is a fence delimiter and toggles `in_fence`; the
 * delimiter line itself and every line strictly inside the fence are code. The
 * backend SKIPS such (`is_code`) blocks entirely before running
 * `detect_attachment_refs`, so we drop those lines here before scanning.
 *
 * Returns the markdown with all code-region lines removed (replaced by empty
 * lines so nothing else shifts). This is a deliberately single-fence-char
 * heuristic, identical to the backend's (tilde fences / language-hint / indent
 * nuances are out of scope on both sides).
 */
function blankFencedCodeLines(markdown: string): string {
  // Normalize EOL + tabs the same way the backend parser does before its
  // line-based pass, so indentation/fence detection agrees.
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ')
  const lines = normalized.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    const trimmedStart = line.replace(/^\s+/, '')
    const fenceDelim = isFenceDelim(trimmedStart)
    const lineIsCode = inFence || fenceDelim
    if (fenceDelim) inFence = !inFence
    out.push(lineIsCode ? '' : line)
  }
  return out.join('\n')
}

/**
 * Scan markdown for the distinct attachment references the #1925 backend will
 * try to match against the supplied vault files.
 *
 * Detects four inbound shapes (mirroring `detect_attachment_refs`):
 *   - Obsidian embed `![[file.png]]` (optional `|display` suffix dropped),
 *   - standard markdown image `![alt](relative/path.png)`, its destination read
 *     by {@link linkDestination} and percent-decoded,
 *   - Logseq/relative asset paths captured by the markdown-image form
 *     (`![alt](assets/...)`),
 *   - a link to a file `[label](paper.pdf)`, read as an image is.
 *
 * SKIPS (leaving nothing to ship):
 *   - absolute / protocol-relative URLs and `data:` URIs,
 *   - already-canonical `attachment:<id>` refs,
 *   - a link to a `#fragment`, to a URL with a scheme (`mailto:`) or to a note,
 *   - any ref inside a ```` ``` ````-fenced code block,
 *   - any ref inside an inline-code span (`` `...` ``).
 *
 * @returns the distinct referenced paths/filenames, in first-seen order: what
 *   `AttachmentRef.original_ref` holds.
 */
export function scanAttachmentRefs(markdown: string): string[] {
  const scanned = blankFencedCodeLines(markdown)
  const spans = inlineCodeSpans(scanned)
  const inCode = (pos: number): boolean => spans.some(([s, e]) => pos >= s && pos < e)

  const refs = new Set<string>()
  const isCandidate = (ref: string): boolean => ref.length > 0 && !isSkippableAttachmentRef(ref)

  // Obsidian embeds first (their `![[...]]` shape cannot also match the
  // markdown-image regex, so the two scans never double-count).
  OBSIDIAN_EMBED_RE.lastIndex = 0
  for (let m = OBSIDIAN_EMBED_RE.exec(scanned); m !== null; m = OBSIDIAN_EMBED_RE.exec(scanned)) {
    const name = (m[1] ?? '').trim()
    if (!inCode(m.index) && isCandidate(name)) refs.add(name)
  }

  // Standard markdown images and links.
  const open = MARKDOWN_LINK_OPEN_RE
  open.lastIndex = 0
  for (let m = open.exec(scanned); m !== null; m = open.exec(scanned)) {
    const token = linkDestination(scanned, open.lastIndex)
    if (token === null) continue
    open.lastIndex = token.end
    const url = token.destination.trim()
    if (inCode(m.index) || !isCandidate(url)) continue
    const ref = percentDecode(url)
    if (m[1] !== undefined || linksAFile(ref)) refs.add(ref)
  }

  return [...refs]
}
