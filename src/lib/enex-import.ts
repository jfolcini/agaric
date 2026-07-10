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
 * DEFERRED (follow-up): `<resource>` / `<en-media>` attachment ingestion,
 * Joplin `.jex`, and advanced ENML fidelity (nested tables, encrypted blocks).
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

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
 * Rewrite Evernote-specific tags in place, before Turndown sees the DOM:
 *  - `<en-todo checked="true|false"/>` → a sentinel text node (later swapped
 *    for a `- [x] ` / `- [ ] ` task marker),
 *  - `<en-media/>` → removed entirely (attachment ingestion is deferred, so
 *    the embedded-resource reference is dropped rather than leaked as markup).
 */
function transformEnmlDom(root: Element): void {
  const ownerDoc = root.ownerDocument
  for (const todo of Array.from(root.querySelectorAll('en-todo'))) {
    const checked = todo.getAttribute('checked') === 'true'
    const sentinel = ownerDoc.createTextNode(
      checked ? TODO_CHECKED_SENTINEL : TODO_UNCHECKED_SENTINEL,
    )
    todo.replaceWith(sentinel)
  }
  for (const media of Array.from(root.querySelectorAll('en-media'))) {
    media.remove()
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
function enmlToMarkdown(td: TurndownService, enml: string): string {
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
  // Rewrite `<en-todo>` → sentinel and drop `<en-media>` before serializing.
  transformEnmlDom(imported)
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

    // `<content>` holds the ENML as CDATA text — `textContent` unwraps it.
    const enml = noteEl.querySelector('content')?.textContent ?? ''
    const markdown = enmlToMarkdown(td, enml)

    const tags = Array.from(noteEl.querySelectorAll('tag'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((tag) => tag.length > 0)

    const createdMs = parseEnexTimestamp(noteEl.querySelector('created')?.textContent)
    const updatedMs = parseEnexTimestamp(noteEl.querySelector('updated')?.textContent)

    return { title, markdown, tags, createdMs, updatedMs }
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
