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
 * frontend mirror of the Rust detector in `src-tauri/src/import.rs`
 * (`detect_attachment_refs`, `is_skippable_attachment_ref`, the
 * `OBSIDIAN_EMBED_RE` / `MARKDOWN_IMAGE_RE` regexes, the fenced-code-block
 * `is_code` skipping in `parse_logseq_markdown`, and `inline_code_spans`).
 *
 * IMPORTANT — these two detectors MUST stay in sync. The FE scanner decides
 * which sibling bytes to ship; the BE detector decides which refs to rewrite.
 * If the FE detects a ref the BE does not, we ship bytes the BE ignores (a
 * harmless waste). If the FE MISSES a ref the BE matches, the BE warns about a
 * missing vault file and leaves the ref un-rewritten. Either way the behaviour
 * must be predictable, so any change to the Rust regexes / skip rules must be
 * reflected here (and vice-versa).
 */

/**
 * Obsidian embed `![[file.png]]` — group 1 is the inner ref (path or basename:
 * any run of chars that is neither `]`, `|`, nor newline; the optional `|alt`
 * display suffix Obsidian allows is dropped). Non-greedy. Mirrors
 * `OBSIDIAN_EMBED_RE`.
 */
const OBSIDIAN_EMBED_RE = /!\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g

/**
 * Standard markdown image `![alt](url)` — group 1 is the alt text (may be
 * empty), group 2 is the URL/path (any run that is neither `)` nor whitespace
 * nor newline). The whitespace exclusion keeps a `![a](url "title")` title out
 * of the captured path. Mirrors `MARKDOWN_IMAGE_RE`.
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s\n]+)\)/g

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
 * Detects three inbound shapes (mirroring `detect_attachment_refs`):
 *   - Obsidian embed `![[file.png]]` (optional `|display` suffix dropped),
 *   - standard markdown image `![alt](relative/path.png)`,
 *   - Logseq/relative asset paths captured by the markdown-image form
 *     (`![alt](assets/...)`).
 *
 * SKIPS (leaving nothing to ship):
 *   - absolute / protocol-relative URLs and `data:` URIs,
 *   - already-canonical `attachment:<id>` refs,
 *   - any ref inside a ```` ``` ````-fenced code block,
 *   - any ref inside an inline-code span (`` `...` ``).
 *
 * @returns the distinct referenced paths/filenames, in first-seen order.
 */
export function scanAttachmentRefs(markdown: string): string[] {
  const scanned = blankFencedCodeLines(markdown)
  const spans = inlineCodeSpans(scanned)
  const inCode = (pos: number): boolean => spans.some(([s, e]) => pos >= s && pos < e)

  const seen = new Set<string>()
  const refs: string[] = []
  const push = (ref: string): void => {
    const r = ref.trim()
    if (r.length === 0 || isSkippableAttachmentRef(r)) return
    if (!seen.has(r)) {
      seen.add(r)
      refs.push(r)
    }
  }

  // Obsidian embeds first (their `![[...]]` shape cannot also match the
  // markdown-image regex, so the two scans never double-count).
  OBSIDIAN_EMBED_RE.lastIndex = 0
  for (let m = OBSIDIAN_EMBED_RE.exec(scanned); m !== null; m = OBSIDIAN_EMBED_RE.exec(scanned)) {
    if (inCode(m.index)) continue
    push(m[1] ?? '')
  }

  // Standard markdown images.
  MARKDOWN_IMAGE_RE.lastIndex = 0
  for (let m = MARKDOWN_IMAGE_RE.exec(scanned); m !== null; m = MARKDOWN_IMAGE_RE.exec(scanned)) {
    if (inCode(m.index)) continue
    push(m[2] ?? '')
  }

  return refs
}
