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
 * bytes and canonicalizes the ref to `attachment:<id>`, an image as an image
 * and any other file as a link to it. An `en-media` whose
 * hash matches no resource is dropped (graceful, no crash); a resource nobody
 * references is simply never shipped.
 *
 * ADVANCED ENML FIDELITY (#2513, part 3): nested `<table>`s are flattened to
 * an inline representation inside the outer cell (GFM pipe tables can't nest,
 * and a raw nested table corrupts the outer one); undecryptable `<en-crypt>`
 * blocks become a `> [!warning]` callout placeholder (ciphertext never leaked);
 * and an `<en-todo>` at the start of an `<li>` renders as a NATIVE task item
 * (`- [ ]`/`- [x]`) instead of a bullet wrapping a task. See
 * {@link transformEnmlDom} and {@link enmlToMarkdown}.
 *
 * TASKS AND REMINDERS (#6032): Evernote 10 writes each task as a `<task>`
 * child of the `<note>`, and in the body only a placeholder `<div>` for its
 * task group. The group's tasks replace that placeholder as task blocks (see
 * {@link placeTaskGroups}); an older note reminder opens the note with a task
 * block named after it, as a Joplin to-do does (see {@link reminderTask}).
 *
 * LINKS BETWEEN NOTES (#6032): an export carries no note GUID, so an
 * `evernote:///view/…` link whose text names a note of the same file (as page
 * names match, {@link nameKey}) links that note's page; any other stays an
 * Evernote link, counted by {@link countEvernoteNoteLinks}.
 *
 * DEFERRED (separate follow-up): Joplin `.jex` import.
 *
 * ACCEPTED MUTATION GAPS (#4815). The mutants still surviving here are
 * equivalent — no input this module can be handed distinguishes them — and are
 * left as gaps rather than chased with tests that pin nothing:
 *   1. fallbacks that cannot fire: the `?? ''` the type system forces on
 *      `Node.textContent`, `Array.pop()` and an in-bounds index, and the `?.`
 *      it forces on a table row's parent;
 *   2. fallbacks whose stand-in value cannot matter, because a mime with no
 *      subtype, an empty body, and a hash matching no resource
 *      converge on the same output whatever it is;
 *   3. MD5's high length word (non-zero only for a resource ≥ 512 MB) and the
 *      one-past-the-end typed-array writes JS silently drops;
 * A fourth family — values nothing observes — is recorded at each site rather
 * than listed here: a list naming code it does not sit on goes quietly wrong
 * the first time that code moves.
 * Two guards against malformed ENML — the `<td>`/`<th>` cell filter and the
 * extension-detect anchor — survive on well-formed input by construction.
 */

import type TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

import { formatDate } from '@/lib/date-utils'
import { createMarkdownTurndown } from '@/lib/markdown-turndown'
import { nameKey } from '@/lib/name-tokens'

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
   * shipped `VaultFile.path`, so the backend matches them (see
   * `match_vault_file`).
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
  /**
   * The note's reminder task, then its ENML body converted to Markdown with its
   * Evernote tasks in place (no frontmatter).
   */
  markdown: string
  /** Tag names as authored in Evernote (may contain spaces). */
  tags: string[]
  /** `<created>` as epoch milliseconds, or null when absent/unparseable. */
  createdMs: number | null
  /** `<updated>` as epoch milliseconds, or null when absent/unparseable. */
  updatedMs: number | null
  /** `<note-attributes><source-url>`: the page a web clip came from, or null. */
  sourceUrl: string | null
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
 * Returns null for an empty or malformed value — the caller
 * treats a null date as "unknown" rather than defaulting to now.
 */
function parseEnexTimestamp(raw: string): number | null {
  const m = ENEX_TIMESTAMP_RE.exec(raw)
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
// Delimiters for indexed `<en-media>` sentinels: `\uE002<index>\uE003`. The
// resource path is spliced in (as `![](path)` from `mediaRefs`) only after
// Turndown runs, so an attacker-controlled path never enters the HTML string.
const MEDIA_SENTINEL_OPEN = '\uE002'
const MEDIA_SENTINEL_CLOSE = '\uE003'
/**
 * Sentinel for an `<en-crypt>` block (#2513). Encrypted Evernote content can't
 * be decrypted on import, so we drop the ciphertext (never leak it) and, in
 * its place, emit a clear callout marker. Like the other markers we route it
 * through Turndown as a private-use text char and swap it for the real
 * (bracket-laden) callout syntax AFTERWARDS, so Turndown never escapes the
 * `[`/`]`/`!` of `> [!warning]`.
 */
const CRYPT_SENTINEL = '\uE004'
/** The callout emitted where an undecryptable `<en-crypt>` block stood. */
const CRYPT_PLACEHOLDER =
  '> [!warning] Encrypted content was omitted during import (Evernote en-crypt block).'
// Delimiters for an indexed task-group sentinel, `\uE005<index>\uE006`: the
// group's task blocks hold `[` and a leading `-`, which Turndown would escape.
const TASK_GROUP_SENTINEL_OPEN = '\uE005'
const TASK_GROUP_SENTINEL_CLOSE = '\uE006'

/**
 * Build the Turndown instance that converts ENML, and a Joplin HTML note, to
 * Markdown. ENML-specific tags (`<en-todo>`, `<en-media>`) are handled by a
 * DOM pre-pass (see {@link transformEnmlDom}) rather than rules, so this is
 * just GFM with the project's markdown style.
 */
export function createHtmlTurndown(): TurndownService {
  const td = createMarkdownTurndown(gfm)
  // A pipe-table row is one line, and Evernote wraps each cell's text in
  // `<div>`s, whose line breaks would end the row mid-cell; a `|` in the text
  // would open a column, and so would one after an odd backslash run, which
  // only raw `<code>` leaves (Turndown doubles text backslashes). Added after
  // the plugin's cell rule, so it wins: the order counts, Turndown never reads
  // the rule's name (#4815).
  td.addRule('enmlTableCell', {
    filter: ['th', 'td'],
    replacement: (cellContent, node) => {
      const text = cellContent
        .trim()
        .replace(/\s*\n\s*/g, ' ')
        .replace(/(\\*)\|/g, (_m, bs: string) => `${bs}${bs.length % 2 === 1 ? '\\' : ''}\\|`)
      return `${node.previousElementSibling === null ? '|' : ''} ${text} |`
    },
  })
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
  const hit = known[mime]
  if (hit !== undefined) return hit
  const sub = (mime.split('/')[1] ?? '').replace(/[^a-z0-9]+/gi, '').toLowerCase()
  return sub.length > 0 && sub.length <= 5 ? sub : 'bin'
}

/** Basename-only, control-char-free resource filename (no path traversal). */
export function sanitizeResourceName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  // Strip C0 control characters (codepoints < 0x20) without a control-char
  // regex literal, then trim surrounding whitespace.
  let out = ''
  for (const ch of base) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && cp >= 0x20) out += ch
  }
  // The backend's image grammar (`link_destination` in import.rs) ends a bare
  // ref at whitespace or an unbalanced `)`, so `![](Screenshot 2024.png)` would
  // never be ingested: the name is the shipped path, so rename both to match.
  return out.trim().replace(/[\p{White_Space}()]+/gu, '_')
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
  // `candidate` always carries an extension — one was appended above when the
  // file-name had none — so the dot is always found.
  const dot = candidate.lastIndexOf('.')
  return `${candidate.slice(0, dot)}-${hash.slice(0, 8)}${candidate.slice(dot)}`
}

/**
 * Rewrite Evernote-specific tags in place, before Turndown sees the DOM:
 *  - `<en-todo checked="true|false"/>` → a sentinel text node (later swapped
 *    for a `- [x] ` / `- [ ] ` task marker),
 *  - `<en-media hash=…/>` → an indexed sentinel text node when the hash matches
 *    a decoded resource; the matching `![](path)` markdown is collected in
 *    `mediaRefs` and spliced back in AFTER Turndown runs. The resource path is
 *    deliberately kept out of the serialized HTML: it is attacker-controlled
 *    (an ENEX resource file name) and routing it through `<img src>` + the
 *    innerHTML→Turndown re-parse would reinterpret DOM text as HTML (CodeQL
 *    js/xss-through-dom). Sentinel-then-splice mirrors the `<en-todo>` handling
 *    and never lets the path touch the HTML string. An `<en-media>` with no
 *    matching resource is dropped (graceful fallback rather than leaking markup
 *    or crashing).
 *  - `<en-crypt>…</en-crypt>` → a block sentinel (later a `> [!warning]`
 *    callout). The ciphertext can't be decrypted on import, so its children are
 *    discarded (never leaked) and replaced by a clear, non-destructive marker
 *    (#2513, advanced ENML fidelity).
 *  - a code block (a `<div>` styled `-en-codeblock:true`, or `--en-codeblock`
 *    in Evernote 10, holding one `<div>` per line) → `<pre><code>`, so Turndown
 *    fences it and leaves its indentation, `#` and `TODO` unread,
 *  - each `<table>`, through {@link prepareTablesForGfm}.
 */
function transformEnmlDom(
  root: Element,
  resources: Map<string, ResourceEntry>,
  used: EnexAttachment[],
  mediaRefs: string[],
): void {
  const ownerDoc = root.ownerDocument
  for (const block of Array.from(root.querySelectorAll('div[style*="en-codeblock:true"]'))) {
    const code = ownerDoc.createElement('code')
    code.textContent = Array.from(block.children, (line) => line.textContent ?? '')
      .join('\n')
      .replace(/\u00A0/g, ' ')
    const pre = ownerDoc.createElement('pre')
    pre.append(code)
    block.replaceWith(pre)
  }
  for (const todo of Array.from(root.querySelectorAll('en-todo'))) {
    const checked = todo.getAttribute('checked') === 'true'
    const sentinel = ownerDoc.createTextNode(
      checked ? TODO_CHECKED_SENTINEL : TODO_UNCHECKED_SENTINEL,
    )
    // Children appear only under the HTML parse (see `parseEnml`), where the
    // self-closing tag swallows what follows it: keep them.
    todo.replaceWith(sentinel, ...Array.from(todo.childNodes))
  }
  for (const media of Array.from(root.querySelectorAll('en-media'))) {
    // A missing or blank hash simply matches nothing: every key is a 32-char
    // MD5 hex digest.
    const hash = media.getAttribute('hash')?.trim().toLowerCase() ?? ''
    const resource = resources.get(hash)
    if (resource === undefined) {
      // No matching resource (dangling hash / unsupported inline media): drop
      // the reference rather than leaking `<en-media>` markup into the body,
      // keeping any children the HTML parse gave it, as for `<en-todo>`.
      media.replaceWith(...Array.from(media.childNodes))
      continue
    }
    if (!used.some((a) => a.path === resource.path)) {
      used.push({ path: resource.path, bytes: resource.bytes, mime: resource.mime })
    }
    const index = mediaRefs.length
    mediaRefs.push(`![](${resource.path})`)
    media.replaceWith(
      ownerDoc.createTextNode(`${MEDIA_SENTINEL_OPEN}${index}${MEDIA_SENTINEL_CLOSE}`),
      ...Array.from(media.childNodes),
    )
  }
  for (const crypt of Array.from(root.querySelectorAll('en-crypt'))) {
    // Wrap the sentinel in a block element so Turndown renders it on its own
    // line(s) — the `> [!warning]` callout it becomes is a block, so it must
    // not be glued to surrounding inline text. Children (the ciphertext) are
    // dropped by replacing the whole element.
    const block = ownerDoc.createElement('p')
    block.append(ownerDoc.createTextNode(CRYPT_SENTINEL))
    crypt.replaceWith(block)
  }
  prepareTablesForGfm(root)
}

/**
 * Shape the `<table>`s under `root` into ones turndown-plugin-gfm writes as
 * pipe tables:
 *  - a nested `<table>` (one inside a `<td>`/`<th>`) → inline text. GFM pipe
 *    tables can't nest — letting Turndown emit the inner table's own rows
 *    splices newlines and `|`s into the OUTER cell and corrupts the whole
 *    table — so each nested table is flattened to a single-line
 *    `cell / cell ; row` string (see {@link flattenNestedTable}) that survives
 *    intact inside the outer pipe cell. The outer (top-level) table still
 *    renders as a real Markdown table (#2513, advanced ENML fidelity).
 *  - a table with no rows → its contents, and one with no header row → its
 *    first row as the header.
 */
export function prepareTablesForGfm(root: Element): void {
  const ownerDoc = root.ownerDocument
  // Flatten nested tables inner-most first: once a nested table is replaced by
  // text, its former parent may itself become a leaf nested table.
  for (
    let nested = findLeafNestedTable(root);
    nested !== null;
    nested = findLeafNestedTable(root)
  ) {
    nested.replaceWith(ownerDoc.createTextNode(flattenNestedTable(nested)))
  }
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const first = table.querySelector('tr')
    if (first === null) {
      // turndown-plugin-gfm reads every table's first row and throws on a
      // table with none, failing the whole file.
      table.replaceWith(...Array.from(table.childNodes))
    } else if (first.parentElement?.localName !== 'thead') {
      // The plugin keeps a table with no header row as raw HTML, and Evernote
      // writes none, nor does many a web clip: its first row is the header.
      const head = ownerDoc.createElement('thead')
      head.append(first)
      table.prepend(head)
    }
  }
}

/**
 * Find a nested `<table>` (a descendant of a `<td>`/`<th>`) that contains no
 * further nested table — a "leaf" — so {@link prepareTablesForGfm} can flatten
 * from the inside out. Returns null when no nested table remains.
 */
function findLeafNestedTable(root: Element): Element | null {
  for (const t of Array.from(root.querySelectorAll('td table, th table'))) {
    if (t.querySelector('table') === null) return t
  }
  return null
}

/** Collapse a cell's text to one safe inline run: no newlines, no `|`. */
function normalizeInlineCell(text: string): string {
  // Collapse all whitespace (incl. newlines) to single spaces and neutralize
  // `|` (which would otherwise open a spurious column in the OUTER pipe row).
  // The trim is load-bearing — see `flattenNestedTable`'s row filter. Only the
  // run WIDTH is unobservable, because Turndown re-collapses what it emits.
  return text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
}

/**
 * Flatten a nested `<table>` to a single-line string safe to drop inside an
 * outer Markdown table cell: cells within a row joined by ` / `, rows joined by
 * ` ; `. All data is preserved (no drop), just linearized — Markdown pipe
 * tables can't nest, so this is the faithful-yet-valid representation.
 */
function flattenNestedTable(table: Element): string {
  const rows: string[] = []
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    // Match cells by localName (case-insensitive): the ENML is parsed as XML
    // and imported, so `tagName` is the lowercase `td`/`th`, not HTML's
    // uppercased form.
    const cells = Array.from(tr.children).filter((c) => {
      const name = c.tagName.toLowerCase()
      return name === 'td' || name === 'th'
    })
    // Keep the row only if a CELL has content. Testing the joined line instead
    // lets a row of empty cells through on the ` / ` separators alone, which
    // emits a stray ` ; / ` slot in the outer cell — and drops a one-cell empty
    // row while keeping a two-cell one (#4815).
    const texts = cells.map((c) => normalizeInlineCell(c.textContent ?? ''))
    if (texts.some((t) => t.length > 0)) rows.push(texts.join(' / '))
  }
  return rows.join(' ; ')
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
 * ENML that fails the XML parse is read as HTML instead (see {@link parseEnml}).
 */
function enmlToMarkdown(
  td: TurndownService,
  enml: string,
  resources: Map<string, ResourceEntry>,
  used: EnexAttachment[],
  taskGroups: Map<string, string>,
): string {
  const trimmed = enml.trim()
  if (trimmed.length === 0) return ''

  const enNote = parseEnml(trimmed)

  // Round-trip through an HTML document so the custom/void tags serialize
  // with explicit close tags (see the doc comment). Reading the en-note's
  // innerHTML strips the wrapper element itself.
  // The title is never read — only this document's body is (#4815).
  const htmlDoc = document.implementation.createHTMLDocument('')
  const imported = htmlDoc.importNode(enNote, true) as Element
  // Rewrite `<en-todo>` → sentinel and `<en-media>` → indexed sentinel (with
  // the matching `![](path)` collected in `mediaRefs`) before serializing;
  // matched resources are appended to `used`. Keeping the resource path out of
  // the HTML avoids the DOM-text-reinterpreted-as-HTML flow CodeQL flags.
  // Seeded empty or otherwise, each ref is keyed by its own index, so the
  // starting contents cannot be observed (#4815).
  const mediaRefs: string[] = []
  transformEnmlDom(imported, resources, used, mediaRefs)
  const taskRefs = placeTaskGroups(imported, taskGroups)
  const bodyHtml = imported.innerHTML

  const markdown = td.turndown(bodyHtml)
  // Swap the sentinels for real markdown post-conversion: media refs first,
  // then the encrypt callout, then the checkbox markers.
  return (
    markdown
      .replace(
        new RegExp(`${MEDIA_SENTINEL_OPEN}(\\d+)${MEDIA_SENTINEL_CLOSE}`, 'g'),
        (_match, index: string) => mediaRefs[Number(index)] ?? '',
      )
      .replace(
        new RegExp(`${TASK_GROUP_SENTINEL_OPEN}(\\d+)${TASK_GROUP_SENTINEL_CLOSE}`, 'g'),
        (_match, index: string) => taskRefs[Number(index)] ?? '',
      )
      .replace(new RegExp(CRYPT_SENTINEL, 'g'), CRYPT_PLACEHOLDER)
      // `<en-todo>` at the START of an `<li>` is a NATIVE task item, not a
      // bullet wrapping a task: Turndown emits the list marker (`-` + spaces)
      // and then the sentinel, so fold the two into one canonical `- [ ] `
      // marker (Agaric's task parser needs exactly `- [ ]`, not `- - [ ]` nor
      // `-   [ ]`). Leading indentation is preserved so nested task items stay
      // nested. These run BEFORE the plain-sentinel swaps below, which then
      // handle any `<en-todo>` outside a list (e.g. inside a `<div>`).
      .replace(new RegExp(`^([ \\t]*)[-*][ \\t]+${TODO_CHECKED_SENTINEL}`, 'gm'), '$1- [x] ')
      .replace(new RegExp(`^([ \\t]*)[-*][ \\t]+${TODO_UNCHECKED_SENTINEL}`, 'gm'), '$1- [ ] ')
      .replace(new RegExp(TODO_CHECKED_SENTINEL, 'g'), '- [x] ')
      .replace(new RegExp(TODO_UNCHECKED_SENTINEL, 'g'), '- [ ] ')
      .trim()
  )
}

/**
 * Swap each Evernote task-group placeholder under `root` for an indexed
 * sentinel standing for its group's task blocks, taking that group out of
 * `taskGroups` so the caller places only the rest. The placeholder's own text
 * tells an older Evernote that tasks are unsupported, so a group with no tasks
 * leaves nothing. Returns the task blocks, by sentinel index.
 */
function placeTaskGroups(root: Element, taskGroups: Map<string, string>): string[] {
  const refs: string[] = []
  for (const div of Array.from(root.querySelectorAll('div[style*="--en-task-group"]'))) {
    const id = /--en-id:\s*([^;]+)/.exec(div.getAttribute('style') ?? '')?.[1]?.trim() ?? ''
    const blocks = taskGroups.get(id)
    if (blocks === undefined) {
      div.remove()
      continue
    }
    taskGroups.delete(id)
    const block = root.ownerDocument.createElement('p')
    block.append(`${TASK_GROUP_SENTINEL_OPEN}${refs.length}${TASK_GROUP_SENTINEL_CLOSE}`)
    div.replaceWith(block)
    refs.push(blocks)
  }
  return refs
}

/**
 * The `<en-note>` element of an ENML document. ENML's DTD imports the XHTML
 * entity sets, so `&nbsp;` and `&eacute;` are legal ENML that an XML parse,
 * which never loads the DTD, rejects; so is any note another tool wrote
 * malformed. Such a note is read as HTML, which keeps all of its text: the
 * only cost is that a self-closing `<en-todo/>` or `<en-media/>` swallows its
 * following siblings, which {@link transformEnmlDom} puts back.
 */
function parseEnml(enml: string): Element {
  const xml = new DOMParser().parseFromString(enml, 'application/xml')
  if (xml.querySelector('parsererror') === null) {
    // A rootless `<content>` falls back to the document element, which a
    // parse without a `<parsererror>` always has.
    return xml.querySelector('en-note') ?? xml.documentElement
  }
  const html = new DOMParser().parseFromString(enml, 'text/html')
  return html.querySelector('en-note') ?? html.body
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
 * Parse an Evernote `.enex` export into {@link EnexNote}s. A link to another
 * note of the file names its page under `fileName` ({@link enexPageName}).
 *
 * @throws {Error} when the XML is malformed (DOMParser produces a
 *   `<parsererror>` element). The caller surfaces this via a notify/error.
 */
export function parseEnex(xmlText: string, fileName: string): EnexNote[] {
  const doc = new DOMParser().parseFromString(normalizeCdata(xmlText), 'application/xml')
  // `application/xml` does not throw on malformed input; it embeds a
  // `<parsererror>` element in the returned document instead.
  if (doc.querySelector('parsererror') !== null) {
    throw new Error('Failed to parse ENEX file: malformed XML.')
  }

  const noteEls = Array.from(doc.querySelectorAll('note'))
  // Each `<task>` holds its own `title`, `created` and `updated`, so the
  // note's are read as direct children.
  const titles = noteEls.map((noteEl) => childText(noteEl, 'title') || UNTITLED_PLACEHOLDER)
  const td = createHtmlTurndown()
  addNoteLinkRule(td, titles, fileName)
  return noteEls.map((noteEl, index) => {
    const title = titles[index] ?? UNTITLED_PLACEHOLDER

    // Decode+index this note's `<resource>` attachments by MD5 (#2513) before
    // converting the body, so `<en-media hash=…>` refs can be matched.
    const resources = indexNoteResources(noteEl)
    // Attachments actually referenced by the body (first-referenced order).
    const attachments: EnexAttachment[] = []

    // `<content>` holds the ENML as CDATA text — `textContent` unwraps it.
    const enml = noteEl.querySelector(':scope > content')?.textContent ?? ''
    const taskGroups = readTaskGroups(noteEl)
    const body = enmlToMarkdown(td, enml, resources, attachments, taskGroups)
    // Tasks whose placeholder the body lacks go after it.
    const markdown = [reminderTask(noteEl, title), body, ...taskGroups.values()]
      .filter((section) => section.length > 0)
      .join('\n\n')

    const tags = Array.from(noteEl.querySelectorAll(':scope > tag'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((tag) => tag.length > 0)

    const createdMs = parseEnexTimestamp(childText(noteEl, 'created'))
    const updatedMs = parseEnexTimestamp(childText(noteEl, 'updated'))
    const rawSourceUrl = childText(noteEl, 'note-attributes > source-url')
    const sourceUrl = rawSourceUrl.length > 0 ? rawSourceUrl : null

    return { title, markdown, tags, createdMs, updatedMs, sourceUrl, attachments }
  })
}

const EVERNOTE_NOTE_LINK = 'evernote:///view/'

/**
 * Teach `td` to write an Evernote note link whose text is one of `titles` as a
 * link to that note's page. Any other link falls through to Turndown's own.
 */
function addNoteLinkRule(td: TurndownService, titles: string[], fileName: string): void {
  const pages = new Map<string, string>()
  for (const title of titles) {
    const page = enexPageName(fileName, title)
    if (!pages.has(nameKey(title))) pages.set(nameKey(title), page)
  }
  const pageOf = (node: HTMLElement) =>
    node.nodeName === 'A' && (node.getAttribute('href') ?? '').startsWith(EVERNOTE_NOTE_LINK)
      ? pages.get(nameKey(node.textContent ?? ''))
      : undefined
  td.addRule('evernoteNoteLink', {
    filter: (node) => pageOf(node) !== undefined,
    replacement: (_content, node) => {
      const page = pageOf(node as HTMLElement) ?? ''
      // The page is always `<file stem>/<title>`, so it never equals the text.
      return `[[${page}|${(node.textContent ?? '').trim()}]]`
    },
  })
}

/** How many links in `notes` are still Evernote note links, none naming a note of their file. */
export function countEvernoteNoteLinks(notes: EnexNote[]): number {
  return notes.reduce((n, note) => n + note.markdown.split(`](${EVERNOTE_NOTE_LINK}`).length - 1, 0)
}

/** The trimmed text of the element at `path` below `parent`'s own children, or `''`. */
function childText(parent: Element, path: string): string {
  return parent.querySelector(`:scope > ${path}`)?.textContent?.trim() ?? ''
}

/** A task block's checkbox state and the days it is scheduled and due. */
export interface TaskBlock {
  done: boolean
  scheduledDate: string | null
  dueDate: string | null
}

/**
 * A task block as Markdown: the title behind the checkbox the importer reads
 * as its state, and its days as `scheduled_date::` / `due_date::` lines, the
 * form a Markdown export writes a task in.
 */
export function todoBlock(title: string, task: TaskBlock): string {
  const lines = [`- [${task.done ? 'x' : ' '}] ${title}`]
  if (task.scheduledDate !== null) lines.push(`  scheduled_date:: ${task.scheduledDate}`)
  if (task.dueDate !== null) lines.push(`  due_date:: ${task.dueDate}`)
  return lines.join('\n')
}

/**
 * An epoch-ms instant as the `YYYY-MM-DD` it falls on in `timeZone`, or in
 * local time when there is none or the runtime does not know it; null when
 * unset (`0`) or unreadable: `formatDate` throws on an invalid date, which
 * would fail the whole file.
 */
export function localDate(ms: number, timeZone = ''): string | null {
  const date = new Date(ms)
  if (!(ms > 0) || Number.isNaN(date.getTime())) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const part = (type: string) => parts.find((p) => p.type === type)?.value
    return `${part('year')}-${part('month')}-${part('day')}`
  } catch {
    // No zone (`''`) or an unknown one throws a RangeError: use the local day.
  }
  return formatDate(date)
}

/** The day an Evernote timestamp falls on in `timeZone` (else local), or null. */
function enexDay(raw: string, timeZone = ''): string | null {
  const ms = parseEnexTimestamp(raw)
  return ms === null ? null : localDate(ms, timeZone)
}

/**
 * A note's Evernote tasks as task blocks, by task group, each group's in
 * `sortWeight` order. A task's flag and recurrence are not read.
 */
function readTaskGroups(noteEl: Element): Map<string, string> {
  const tasks = Array.from(noteEl.querySelectorAll(':scope > task')).map((task) => ({
    group: childText(task, 'taskGroupNoteLevelID'),
    weight: childText(task, 'sortWeight'),
    block: todoBlock(childText(task, 'title'), {
      done: childText(task, 'taskStatus') === 'completed',
      scheduledDate: enexDay(
        childText(task, 'reminder > reminderDate'),
        childText(task, 'reminder > timeZone') || childText(task, 'timeZone'),
      ),
      dueDate: enexDay(childText(task, 'dueDate'), childText(task, 'timeZone')),
    }),
  }))
  // Evernote orders tasks by comparing the weight strings, not by locale.
  tasks.sort((a, b) => (a.weight < b.weight ? -1 : a.weight > b.weight ? 1 : 0))
  const groups = new Map<string, string[]>()
  for (const { group, block } of tasks) groups.set(group, [...(groups.get(group) ?? []), block])
  return new Map(Array.from(groups, ([group, blocks]) => [group, blocks.join('\n')]))
}

/**
 * The task block a note with an older Evernote reminder opens with, named
 * after the note: done once the reminder is, due on the reminder's local day.
 * `''` for a note with no reminder.
 */
function reminderTask(noteEl: Element, title: string): string {
  const attribute = (name: string) => childText(noteEl, `note-attributes > ${name}`)
  const time = attribute('reminder-time')
  const doneTime = attribute('reminder-done-time')
  if (time.length === 0 && doneTime.length === 0 && attribute('reminder-order').length === 0) {
    return ''
  }
  return todoBlock(title, {
    done: doneTime.length > 0,
    scheduledDate: null,
    dueDate: enexDay(time),
  })
}

/**
 * The look-alike for each character a page name splits into namespace levels on:
 * `/`, and `\`, which the backend reads as `/` (#6032).
 */
const SEPARATOR_LOOKALIKES = { '/': '\u2215', '\\': '\u29F5' } as const

/** `title` as one namespace level: each separator swapped for its look-alike. */
export function escapeTitleSeparators(title: string): string {
  return title.replace(
    /[/\\]/g,
    (c) => SEPARATOR_LOOKALIKES[c as keyof typeof SEPARATOR_LOOKALIKES],
  )
}

/**
 * Sanitize a note title for use as ONE imported page name / import filename.
 *
 * A `/` or `\` in a note's title is part of its name, not a namespace, so it
 * is escaped ({@link escapeTitleSeparators}): Evernote's `TCP/IP` stays one
 * page. Whitespace collapses (newlines/tabs are invalid in a page name), and
 * an otherwise-empty result falls back to the {@link UNTITLED_PLACEHOLDER}.
 */
export function sanitizeNoteTitleToFilename(title: string): string {
  const cleaned = escapeTitleSeparators(title.replace(/\s+/g, ' ').trim())
  return cleaned.length > 0 ? cleaned : UNTITLED_PLACEHOLDER
}

/**
 * The page a note of the `.enex` file `fileName` imports as: `<file stem>/<title>`,
 * since an export names no notebook, each part one namespace level.
 */
export function enexPageName(fileName: string, title: string): string {
  const notebook = sanitizeNoteTitleToFilename(fileName.replace(/\.enex$/i, ''))
  return `${notebook}/${sanitizeNoteTitleToFilename(title)}`
}

/**
 * Compose the final Markdown handed to `importMarkdown` for a note:
 *
 *   1. a YAML frontmatter block (`created` / `updated` as ISO strings and
 *      `source-url` when known, the note's `tags`, plus `source: evernote`) —
 *      applied by the importer as page properties (#1432) and page tags,
 *   2. the converted ENML body.
 *
 * The tags are written as `jexNoteToMarkdown` writes Joplin's, so `C++` or
 * `2024` is one tag; a pretty-printed `<tag>`'s line breaks would end the
 * item, so whitespace collapses.
 */
export function enexNoteToMarkdown(note: EnexNote): string {
  const frontmatter: string[] = ['---']
  if (note.createdMs !== null) {
    frontmatter.push(`created: "${new Date(note.createdMs).toISOString()}"`)
  }
  if (note.updatedMs !== null) {
    frontmatter.push(`updated: "${new Date(note.updatedMs).toISOString()}"`)
  }
  if (note.sourceUrl !== null) {
    frontmatter.push(`source-url: "${note.sourceUrl}"`)
  }
  if (note.tags.length > 0) {
    frontmatter.push('tags:', ...note.tags.map((tag) => `  - "${tag.trim().replace(/\s+/g, ' ')}"`))
  }
  frontmatter.push('source: evernote')
  frontmatter.push('---')

  const sections: string[] = [frontmatter.join('\n')]

  if (note.markdown.length > 0) {
    sections.push(note.markdown)
  }

  // Blank line between blocks; trailing newline for a well-formed document.
  return `${sections.join('\n\n')}\n`
}
