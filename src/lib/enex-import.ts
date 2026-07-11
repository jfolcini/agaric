/**
 * Frontend-only Evernote `.enex` importer (#1282, Evernote slice).
 *
 * An Evernote export (`.enex`) is a single XML document: a root `<en-export>`
 * carrying one or more `<note>`s. Each note's body lives in a `<content>`
 * element as a CDATA-wrapped ENML document (`<en-note>…</en-note>`), a flavour
 * of XHTML with a couple of Evernote-specific tags (`<en-todo/>` checkboxes,
 * `<en-media/>` attachment references).
 *
 * This module is PURE (no IPC, no Tauri): it parses the ENEX XML in the
 * browser, converts each note's ENML to Markdown via Turndown, and returns
 * plain {@link EnexNote} records. The caller (DataTab) then hands each note's
 * composed markdown to the EXISTING `importMarkdown` IPC — one note → one page.
 * The markdown importer already resolves `[[wikilinks]]`, `#tags`,
 * folder→namespace, and YAML frontmatter, so we only PRODUCE markdown here and
 * never reimplement any of that.
 *
 * ATTACHMENTS (#2513, part 1): ENEX embeds attachments as base64 `<resource>`
 * blocks referenced from the note body by `<en-media hash=… type=…/>`, where
 * `hash` is the lowercase MD5 hex of the resource's raw (decoded) bytes. We
 * decode each `<resource>`, index them by that MD5, match `en-media` refs to
 * resources, rewrite each matched ref to a standard markdown image embed
 * (`![](path)`) and hand the bytes back on {@link EnexNote.attachments}. The
 * caller ships those as `importMarkdown`'s `vaultFiles` — the SAME
 * vault-attachment path a folder import uses — so the backend ingests the
 * bytes and canonicalizes the ref to `attachment:<id>`. An `en-media` whose
 * hash matches no resource is dropped (graceful, no crash); a resource nobody
 * references is simply never shipped.
 *
 * DEFERRED (follow-up, still open on #2513): Joplin `.jex` import (part 2) and
 * advanced ENML fidelity — nested tables, encrypted blocks, `<en-todo>` inside
 * `<li>` (part 3).
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/**
 * One decoded, referenced `<resource>` attachment for a note (#2513). Only
 * resources actually referenced by an `<en-media>` in the body are surfaced —
 * `path` matches the markdown ref emitted into {@link EnexNote.markdown}, and
 * `bytes` are the raw decoded resource bytes. The caller ships these as
 * `importMarkdown`'s `vaultFiles` (`{ path, bytes }`), which the backend
 * matches against the ref and ingests via `add_attachment_with_bytes`.
 */
export interface EnexAttachment {
  /**
   * Vault-relative path used both as the markdown embed target and the
   * shipped `VaultFile.path`, so the backend matches them (relative-path
   * equality, then basename — see `match_vault_file`).
   */
  path: string
  /** Raw decoded resource bytes (the exact bytes Evernote MD5-hashes). */
  bytes: Uint8Array
  /** The resource's declared MIME type (`<mime>`), e.g. `image/png`. */
  mime: string
}

/** A single parsed Evernote note, ready to compose into importer markdown. */
export interface EnexNote {
  /** Note title; defaults to {@link UNTITLED_PLACEHOLDER} when empty/absent. */
  title: string
  /** The ENML body converted to Markdown (no frontmatter, no tag tokens). */
  markdown: string
  /** Tag names as authored in Evernote (may contain spaces). */
  tags: string[]
  /** `<created>` as epoch milliseconds, or null when absent/unparseable. */
  createdMs: number | null
  /** `<updated>` as epoch milliseconds, or null when absent/unparseable. */
  updatedMs: number | null
  /**
   * Decoded attachments referenced by the body's `<en-media>` tags (#2513),
   * in first-referenced order. Empty when the note embeds no (resolvable)
   * media. Shipped as `importMarkdown`'s `vaultFiles`.
   */
  attachments: EnexAttachment[]
}

/** Placeholder title for a note whose `<title>` is empty or missing. */
export const UNTITLED_PLACEHOLDER = 'Untitled'

/**
 * Evernote timestamp shape `YYYYMMDDTHHMMSSZ` (always UTC). Group order is
 * year, month, day, hour, minute, second.
 */
const ENEX_TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

/**
 * Parse an Evernote `YYYYMMDDTHHMMSSZ` timestamp to epoch milliseconds.
 * Returns null for an absent (`null`/empty) or malformed value — the caller
 * treats a null date as "unknown" rather than defaulting to now.
 */
function parseEnexTimestamp(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const m = ENEX_TIMESTAMP_RE.exec(raw.trim())
  if (m === null) return null
  const [, y, mo, d, h, mi, s] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return Number.isNaN(ms) ? null : ms
}

/**
 * Private-use sentinel characters standing in for an `<en-todo>` checkbox
 * while the DOM passes through Turndown, then swapped for the real task
 * markers afterwards. We can't emit `- [x] ` from a Turndown rule: an empty
 * `<en-todo/>` element is treated as "blank" and short-circuited to Turndown's
 * blank rule BEFORE any custom rule runs, so the marker would be lost.
 * Substituting a text sentinel (which Turndown neither escapes nor drops) and
 * post-processing avoids that, and also sidesteps Turndown's escaping of `[`,
 * `]`, and a leading `-` in text.
 */
const TODO_CHECKED_SENTINEL = '\uE000'
const TODO_UNCHECKED_SENTINEL = '\uE001'

/**
 * Build the shared Turndown instance used to convert ENML → Markdown.
 * ENML-specific tags (`<en-todo>`, `<en-media>`) are handled by a DOM pre-pass
 * (see {@link transformEnmlDom}) rather than rules, so this is just GFM with
 * the project's markdown style.
 */
function createEnmlTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  td.use(gfm)
  return td
}

/**
 * Compute the lowercase MD5 hex digest of a byte array (#2513).
 *
 * Evernote references an embedded `<resource>` from the note body via
 * `<en-media hash=…/>`, where `hash` is the MD5 of the resource's RAW decoded
 * bytes (RFC 1321). The Web Crypto API does not offer MD5, so this is a small
 * self-contained implementation over `Uint8Array`. Correctness is what makes
 * the whole feature work (a wrong digest silently matches nothing), so it is
 * exercised end-to-end by the resource-match tests.
 */
function md5Hex(input: Uint8Array): string {
  const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c))
  // Per-round left-rotate amounts (typed array so indexing is `number`, not
  // `number | undefined` under noUncheckedIndexedAccess).
  const S = new Uint8Array([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ])
  // Per-round additive constants K[i] = floor(abs(sin(i+1)) * 2^32), stored as
  // 32-bit words (the signed wrap is harmless — all arithmetic is mod 2^32).
  const K = new Int32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

  const originalLenBits = input.length * 8
  const withOne = input.length + 1
  // Pad with 0x80 then zeros up to ≡ 56 (mod 64), then an 8-byte LE bit length.
  const padZeros = (56 - (withOne % 64) + 64) % 64
  const totalLen = withOne + padZeros + 8
  const msg = new Uint8Array(totalLen)
  msg.set(input)
  msg[input.length] = 0x80
  const dv = new DataView(msg.buffer)
  dv.setUint32(totalLen - 8, originalLenBits >>> 0, true)
  dv.setUint32(totalLen - 4, Math.floor(originalLenBits / 4294967296) >>> 0, true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let chunk = 0; chunk < totalLen; chunk += 64) {
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      // `i` is always 0..63, so these `?? 0` fallbacks never fire; they only
      // satisfy noUncheckedIndexedAccess's `number | undefined` on index access.
      F = (F + A + (K[i] ?? 0) + dv.getUint32(chunk + g * 4, true)) | 0
      A = D
      D = C
      C = B
      B = (B + rotl(F, S[i] ?? 0)) | 0
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  const toHexLE = (n: number): string => {
    let h = ''
    for (let i = 0; i < 4; i++) h += (((n >>> (i * 8)) & 0xff) + 0x100).toString(16).slice(1)
    return h
  }
  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0)
}

/**
 * Decode a base64 `<resource>` payload to raw bytes (#2513). ENEX wraps the
 * base64 across lines, so all non-base64 characters (whitespace/newlines) are
 * stripped before `atob`. Returns null when the payload is empty or `atob`
 * rejects it (malformed base64) so the caller can skip the resource rather
 * than crash the whole import.
 */
function decodeResourceData(raw: string): Uint8Array | null {
  const clean = raw.replace(/[^A-Za-z0-9+/=]/g, '')
  if (clean.length === 0) return null
  try {
    const bin = atob(clean)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** Map a resource MIME type to a filename extension (best-effort). */
function mimeToExt(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'text/plain': 'txt',
  }
  if (mime in known) return known[mime] ?? 'bin'
  const sub = (mime.split('/')[1] ?? '').replace(/[^a-z0-9]+/gi, '').toLowerCase()
  return sub.length > 0 && sub.length <= 5 ? sub : 'bin'
}

/** Basename-only, control-char-free resource filename (no path traversal). */
function sanitizeResourceName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  // Strip C0 control characters (codepoints < 0x20) without a control-char
  // regex literal, then trim surrounding whitespace.
  let out = ''
  for (const ch of base) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && cp >= 0x20) out += ch
  }
  return out.trim()
}

/** A decoded resource plus the vault-relative path it will be embedded/shipped as. */
interface ResourceEntry {
  path: string
  bytes: Uint8Array
  mime: string
}

/**
 * Decode a note's `<resource>` blocks and index them by lowercase MD5 hex
 * (#2513) — the key an `<en-media hash=…>` matches against. Resources are
 * deduped by hash (identical bytes → one entry). Each entry is assigned a
 * deterministic, note-unique `path`: the resource's `<file-name>` when present
 * (basename only, extension inferred from `<mime>` if absent), else
 * `<md5>.<ext>`; a filename collision is disambiguated with a short hash.
 */
function indexNoteResources(noteEl: Element): Map<string, ResourceEntry> {
  const byHash = new Map<string, ResourceEntry>()
  const usedPaths = new Set<string>()
  for (const res of Array.from(noteEl.querySelectorAll('resource'))) {
    const bytes = decodeResourceData(res.querySelector('data')?.textContent ?? '')
    if (bytes === null) continue
    const hash = md5Hex(bytes)
    if (byHash.has(hash)) continue
    const mime = res.querySelector('mime')?.textContent?.trim() ?? 'application/octet-stream'
    const fileName = sanitizeResourceName(res.querySelector('file-name')?.textContent ?? '')
    const path = uniqueResourcePath(fileName, mime, hash, usedPaths)
    usedPaths.add(path)
    byHash.set(hash, { path, bytes, mime })
  }
  return byHash
}

/** Assign a note-unique vault path for one resource (see {@link indexNoteResources}). */
function uniqueResourcePath(
  fileName: string,
  mime: string,
  hash: string,
  used: Set<string>,
): string {
  const ext = mimeToExt(mime)
  let candidate: string
  if (fileName.length > 0) {
    candidate = /\.[^./\\]+$/.test(fileName) ? fileName : `${fileName}.${ext}`
  } else {
    candidate = `${hash}.${ext}`
  }
  if (!used.has(candidate)) return candidate
  // Filename collision across distinct resources — disambiguate with a short
  // hash prefix on the stem so both survive as distinct vault files.
  const dot = candidate.lastIndexOf('.')
  const stem = dot === -1 ? candidate : candidate.slice(0, dot)
  const suffix = dot === -1 ? '' : candidate.slice(dot)
  return `${stem}-${hash.slice(0, 8)}${suffix}`
}

/**
 * Rewrite Evernote-specific tags in place, before Turndown sees the DOM:
 *  - `<en-todo checked="true|false"/>` → a sentinel text node (later swapped
 *    for a `- [x] ` / `- [ ] ` task marker),
 *  - `<en-media hash=…/>` → a standard `<img src="<resource path>">` when the
 *    hash matches a decoded resource (Turndown serializes it to `![](path)`,
 *    the ref the backend matches to the shipped bytes), recording the resource
 *    in `used`; an `<en-media>` with no matching resource is dropped (graceful
 *    fallback rather than leaking markup or crashing).
 */
function transformEnmlDom(
  root: Element,
  resources: Map<string, ResourceEntry>,
  used: EnexAttachment[],
): void {
  const ownerDoc = root.ownerDocument
  for (const todo of Array.from(root.querySelectorAll('en-todo'))) {
    const checked = todo.getAttribute('checked') === 'true'
    const sentinel = ownerDoc.createTextNode(
      checked ? TODO_CHECKED_SENTINEL : TODO_UNCHECKED_SENTINEL,
    )
    todo.replaceWith(sentinel)
  }
  for (const media of Array.from(root.querySelectorAll('en-media'))) {
    const hash = media.getAttribute('hash')?.trim().toLowerCase() ?? ''
    const resource = hash.length > 0 ? resources.get(hash) : undefined
    if (resource === undefined) {
      // No matching resource (dangling hash / unsupported inline media): drop
      // the reference rather than leaking `<en-media>` markup into the body.
      media.remove()
      continue
    }
    if (!used.some((a) => a.path === resource.path)) {
      used.push({ path: resource.path, bytes: resource.bytes, mime: resource.mime })
    }
    const img = ownerDoc.createElement('img')
    img.setAttribute('src', resource.path)
    media.replaceWith(img)
  }
}

/**
 * Convert an ENML document string (`<en-note>…</en-note>`, possibly prefixed
 * with an XML declaration and DOCTYPE) to Markdown.
 *
 * ENML is XHTML, so Evernote's self-closing tags (`<en-todo/>`, `<en-media/>`,
 * `<br/>`) are only correct under an XML parse. Turndown re-parses its string
 * input as HTML, where a self-closing UNKNOWN element (`<en-todo/>`) does not
 * close and swallows its following siblings. To avoid that we:
 *   1. parse the ENML with `application/xml` (self-closing respected),
 *   2. import the `<en-note>` element into an HTML document and read its
 *      `innerHTML` — HTML serialization emits EXPLICIT close tags
 *      (`<en-todo …></en-todo>`), fixing the swallow — which also strips the
 *      `<en-note>` wrapper,
 *   3. hand that well-formed HTML to Turndown.
 * A content string that fails to parse yields an empty body (the note still
 * imports, just without its ENML).
 */
function enmlToMarkdown(
  td: TurndownService,
  enml: string,
  resources: Map<string, ResourceEntry>,
  used: EnexAttachment[],
): string {
  const trimmed = enml.trim()
  if (trimmed.length === 0) return ''

  const doc = new DOMParser().parseFromString(trimmed, 'application/xml')
  if (doc.querySelector('parsererror') !== null) return ''
  const enNote = doc.querySelector('en-note') ?? doc.documentElement
  if (enNote == null) return ''

  // Round-trip through an HTML document so the custom/void tags serialize
  // with explicit close tags (see the doc comment). Reading the en-note's
  // innerHTML strips the wrapper element itself.
  const htmlDoc = document.implementation.createHTMLDocument('')
  const imported = htmlDoc.importNode(enNote, true) as Element
  // Rewrite `<en-todo>` → sentinel and `<en-media>` → `<img>`/drop before
  // serializing; matched resources are appended to `used`.
  transformEnmlDom(imported, resources, used)
  const bodyHtml = imported.innerHTML

  const markdown = td.turndown(bodyHtml)
  // Swap the checkbox sentinels for real task markers post-conversion.
  return markdown
    .replace(new RegExp(TODO_CHECKED_SENTINEL, 'g'), '- [x] ')
    .replace(new RegExp(TODO_UNCHECKED_SENTINEL, 'g'), '- [ ] ')
    .trim()
}

/** XML-escape the `&`, `<`, `>` in a raw text run. */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Replace every `<![CDATA[ … ]]>` section with its XML-escaped text.
 *
 * Evernote wraps each note's ENML body in a CDATA section inside `<content>`.
 * Real browsers' `DOMParser` handle CDATA natively, but the test runtime's XML
 * parser (happy-dom) rejects CDATA sections outright, failing the whole parse.
 * Normalizing CDATA → escaped text up front makes the parse behave identically
 * everywhere; `textContent` on the element then still yields the original
 * unescaped ENML string. (A `.enex` that entity-escapes its content instead of
 * using CDATA has no CDATA sections and passes through untouched.)
 */
function normalizeCdata(xmlText: string): string {
  return xmlText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => escapeXmlText(inner))
}

/**
 * Parse an Evernote `.enex` export into {@link EnexNote}s.
 *
 * @throws {Error} when the XML is malformed (DOMParser produces a
 *   `<parsererror>` element). The caller surfaces this via a notify/error.
 */
export function parseEnex(xmlText: string): EnexNote[] {
  const doc = new DOMParser().parseFromString(normalizeCdata(xmlText), 'application/xml')
  // `application/xml` does not throw on malformed input; it embeds a
  // `<parsererror>` element in the returned document instead.
  if (doc.querySelector('parsererror') !== null) {
    throw new Error('Failed to parse ENEX file: malformed XML.')
  }

  const td = createEnmlTurndown()
  const noteEls = Array.from(doc.querySelectorAll('note'))
  return noteEls.map((noteEl) => {
    const rawTitle = noteEl.querySelector('title')?.textContent?.trim() ?? ''
    const title = rawTitle.length > 0 ? rawTitle : UNTITLED_PLACEHOLDER

    // Decode+index this note's `<resource>` attachments by MD5 (#2513) before
    // converting the body, so `<en-media hash=…>` refs can be matched.
    const resources = indexNoteResources(noteEl)
    // Attachments actually referenced by the body (first-referenced order).
    const attachments: EnexAttachment[] = []

    // `<content>` holds the ENML as CDATA text — `textContent` unwraps it.
    const enml = noteEl.querySelector('content')?.textContent ?? ''
    const markdown = enmlToMarkdown(td, enml, resources, attachments)

    const tags = Array.from(noteEl.querySelectorAll('tag'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((tag) => tag.length > 0)

    const createdMs = parseEnexTimestamp(noteEl.querySelector('created')?.textContent)
    const updatedMs = parseEnexTimestamp(noteEl.querySelector('updated')?.textContent)

    return { title, markdown, tags, createdMs, updatedMs, attachments }
  })
}

/**
 * Render one Evernote tag as an inline tag token the markdown importer
 * understands (#1924/#1950): a single-word tag becomes `#tag`; a tag whose
 * (whitespace-collapsed) name contains a space becomes the multi-word form
 * `#[[Multi Word]]`, matching the importer's `#[[Tag With Space]]` syntax so
 * the tag survives as ONE tag instead of truncating at the first space.
 */
function tagToToken(tag: string): string {
  const name = tag.trim().replace(/\s+/g, ' ')
  return /\s/.test(name) ? `#[[${name}]]` : `#${name}`
}

/**
 * Sanitize a note title for use as the imported page name / import filename.
 *
 * The markdown importer treats `/` in a filename as a namespace separator
 * (the folder→namespace convention), so we deliberately KEEP `/` here: an
 * Evernote note titled `Projects/Roadmap` lands as the namespaced page
 * `Projects/Roadmap`, consistent with a folder import. We only collapse
 * whitespace (newlines/tabs are invalid in a page name) and fall back to the
 * {@link UNTITLED_PLACEHOLDER} for an otherwise-empty result.
 */
export function sanitizeNoteTitleToFilename(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : UNTITLED_PLACEHOLDER
}

/**
 * Compose the final Markdown handed to `importMarkdown` for a note:
 *
 *   1. a YAML frontmatter block (`created` / `updated` as ISO strings when
 *      known, plus `source: evernote`) — applied by the importer as page
 *      properties (#1432),
 *   2. the note's tags as inline `#tag` / `#[[Multi Word]]` tokens on one
 *      line (omitted when there are none),
 *   3. the converted ENML body.
 */
export function enexNoteToMarkdown(note: EnexNote): string {
  const frontmatter: string[] = ['---']
  if (note.createdMs !== null) {
    frontmatter.push(`created: "${new Date(note.createdMs).toISOString()}"`)
  }
  if (note.updatedMs !== null) {
    frontmatter.push(`updated: "${new Date(note.updatedMs).toISOString()}"`)
  }
  frontmatter.push('source: evernote')
  frontmatter.push('---')

  const sections: string[] = [frontmatter.join('\n')]

  if (note.tags.length > 0) {
    sections.push(note.tags.map(tagToToken).join(' '))
  }

  if (note.markdown.length > 0) {
    sections.push(note.markdown)
  }

  // Blank line between blocks; trailing newline for a well-formed document.
  return `${sections.join('\n\n')}\n`
}
