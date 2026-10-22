/**
 * Notion's Markdown export as the Markdown a folder import reads (#6032).
 *
 * Notion names every page file and folder `Title <32-hex id>`, links pages by
 * those names, opens a page with its title as `# Title`, writes a database
 * row's properties as `Key: value` lines under it, and keeps callouts and
 * toggles as HTML. Each becomes what the importer already reads: the title
 * without its id, `key:: value` page properties, and `> [!note]` callouts.
 * Agaric stores no toggle, so a toggle is a callout titled by its summary.
 */

import { FOLDED_RESERVED_KEYS, foldPropertyKey } from '@/lib/inline-property-parse'

/** The id Notion appends to a file or folder name, before any extension. */
const NAME_ID_RE = / [0-9a-f]{32}(?=(?:\.[^./]*)?$)/

/** The id inside a percent-encoded link destination, before `.md` or a `/`. */
const LINK_ID_RE = /%20[0-9a-f]{32}(?=\.md$|\/)/g

/** A link to a `.md` file: group 1 is its destination. */
const MD_LINK_DEST_RE = /\]\(([^)\s]+\.md)\)/g

/** A `Key: value` property line Notion writes under a page title. */
const PROPERTY_LINE_RE = /^([\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} ._()-]{0,63}): (\S.*)$/u

/** An opening `<aside>` or `<details>` on its own line, after any indent. */
const HTML_OPEN_RE = /^(\s*)<(aside|details)>(.*)$/

const SUMMARY_RE = /^\s*<summary>(.*?)<\/summary>\s*$/

/** A code fence's opening run, after any indent. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/

/**
 * Whether the picked `.md` file names read as a Notion export: most carry the
 * id suffix, so a plain folder with one such name is left alone.
 */
export function isNotionExport(mdNames: readonly string[]): boolean {
  const named = mdNames.filter((name) => / [0-9a-f]{32}\.md$/.test(name)).length
  return named * 2 > mdNames.length
}

/** `path` with Notion's id taken off each of its segments. */
export function stripNotionIds(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.replace(NAME_ID_RE, ''))
    .join('/')
}

/**
 * A Notion page's text as the importer reads it. `title` is the page's file
 * name without its id: a leading `# title` repeats it and goes, while a heading
 * that differs stays a block.
 */
export function notionToMarkdown(content: string, title: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const heading = lines[0]?.startsWith('# ') ? lines.shift() : undefined
  while (lines[0]?.trim() === '') lines.shift()

  const end = lines.findIndex((line) => line.trim() === '')
  const block = end === -1 ? lines : lines.slice(0, end)
  const properties = block.map(propertyLine)
  const read = block.length > 0 && properties.every((line) => line !== null)
  const body = read ? lines.slice(block.length) : lines
  while (body[0]?.trim() === '') body.shift()

  const head = read ? [...(properties as string[]), ''] : []
  if (heading !== undefined && heading.slice(2).trim() !== title) head.push(heading, '')
  let fence: string | null = null
  return [...head, ...htmlBlocksToCallouts(body)]
    .map((line) => {
      const before = fence
      fence = fenceAfter(fence, line)
      if (before !== null || fence !== null) return line
      return line.replace(
        MD_LINK_DEST_RE,
        (_, dest: string) => `](${dest.replace(LINK_ID_RE, '')})`,
      )
    })
    .join('\n')
}

/**
 * The code fence open after `line`, given `open`, the one open before it. A
 * line is code when a fence is open before or after it.
 */
function fenceAfter(open: string | null, line: string): string | null {
  const run = FENCE_RE.exec(line)?.[1]
  if (open === null) return run ?? null
  return run !== undefined && run[0] === open[0] && run.length >= open.length ? null : open
}

/**
 * `Key: value` as a `key:: value` line, its key in the alphabet a property key
 * allows (`Due date` is `due-date`), or null when the line is not one. A key
 * the app reserves (`Space`, `Created at`) makes it none: the import drops such
 * a page property without a word, while prose keeps the line.
 */
function propertyLine(line: string): string | null {
  const match = PROPERTY_LINE_RE.exec(line.trim())
  if (match === null) return null
  const key = (match[1] as string)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (key === '' || FOLDED_RESERVED_KEYS.has(foldPropertyKey(key))) return null
  return `${key}:: ${(match[2] as string).trim()}`
}

/** Each `<aside>` and `<details>` block of `lines` as a `> [!note]` callout. */
function htmlBlocksToCallouts(lines: readonly string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const before = fence
    fence = fenceAfter(fence, line)
    const open = before === null && fence === null ? HTML_OPEN_RE.exec(line) : null
    const close = open === null ? -1 : closingLine(lines, i, open[2] as string)
    if (open === null || close === -1) {
      out.push(line)
      continue
    }
    const indent = open[1] as string
    const tag = open[2] as string
    const after = (open[3] as string).replace(`</${tag}>`, '').trim()
    let inner = lines
      .slice(i + 1, close)
      .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
    if (after !== '') inner.unshift(after)
    let title = ''
    const first = inner.findIndex((l) => l.trim() !== '')
    const summary =
      tag === 'details' && first !== -1 ? SUMMARY_RE.exec(inner[first] as string) : null
    if (summary !== null) {
      title = (summary[1] as string).trim()
      inner = inner.slice(first + 1)
    }
    out.push(...callout(title, htmlBlocksToCallouts(inner)).map((l) => indent + l))
    i = close
  }
  return out
}

/** The index of the line closing the `tag` block opened at `open`, or -1. */
function closingLine(lines: readonly string[], open: number, tag: string): number {
  let depth = 0
  for (let i = open; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim()
    if (trimmed.startsWith(`<${tag}>`)) depth++
    if (trimmed.endsWith(`</${tag}>`)) depth--
    if (depth === 0) return i
  }
  return -1
}

/** `body` quoted as a `[!note]` callout, `title` or its first line on the marker's line. */
function callout(title: string, body: readonly string[]): string[] {
  const lines = [...body]
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()
  const first = title === '' ? (lines.shift() ?? '') : title
  return [
    `> [!note]${first === '' ? '' : ` ${first}`}`,
    ...lines.map((l) => (l === '' ? '>' : `> ${l}`)),
  ]
}
