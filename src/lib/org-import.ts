/**
 * An Org file (`.org`) as the Markdown the import reads (#6032), per the
 * maintainer's decision of 2026-10-22 on a basic Org import.
 *
 * Each headline becomes a bullet nested by its stars, its text kept whole: the
 * importer already reads a leading TODO/DONE keyword, a `[#A]` cookie and a
 * `SCHEDULED:` / `DEADLINE:` line under a bullet, as it does Logseq's. A
 * `:PROPERTIES:` drawer becomes `key:: value` lines (before the first
 * headline, the page's properties), `[[target][desc]]` a Markdown link, and
 * `#+TITLE` the page title. Source and example blocks become code fences, so a
 * `*` line in them is no headline; tables and other text come in as written.
 * A `# comment` line, which Org itself never shows, and `CLOSED:` stamps go.
 */

import { FOLDED_RESERVED_KEYS, foldPropertyKey } from '@/lib/inline-property-parse'

/** What {@link orgToMarkdown} reads: the `#+TITLE`, if any, and the text. */
export interface OrgPage {
  title: string | null
  markdown: string
}

const HEADLINE_RE = /^(\*+)[ \t]+(.*)$/
const TITLE_RE = /^#\+title:\s*(.*)$/i
const BEGIN_RE = /^#\+begin_(\w+)\s*(\S*)/i
const END_RE = /^#\+end_\w+/i
const DRAWER_PROPERTY_RE = /^:([^:\s]+):\s*(.*)$/
const DRAWER_END_RE = /^:end:$/i
const PLANNING_RE = /^(?:CLOSED|SCHEDULED|DEADLINE):/
const CLOSED_RE = /CLOSED:\s*\[[^\]]*\]\s*/g
/** `[[target]]` or `[[target][desc]]`. */
const LINK_RE = /\[\[([^\]\n]+)\](?:\[([^\]\n]+)\])?\]/g
const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i

export function orgToMarkdown(org: string): OrgPage {
  let title: string | null = null
  const out: string[] = []
  let section: string[] = []
  let indent = ''
  const flush = (): void => {
    out.push(
      ...sectionToMarkdown(section, indent, (text) => {
        title ??= text
      }),
    )
    section = []
  }
  for (const line of org.replace(/\r\n?/g, '\n').split('\n')) {
    const headline = HEADLINE_RE.exec(line)
    if (headline === null) {
      section.push(line)
      continue
    }
    flush()
    const depth = (headline[1] as string).length
    out.push(`${'  '.repeat(depth - 1)}- ${orgLinks((headline[2] as string).trimEnd())}`)
    indent = '  '.repeat(depth)
  }
  flush()
  return { title, markdown: `${out.join('\n')}\n` }
}

/**
 * The lines under one headline (or before the first), less their common
 * indent, at the content column `indent` of the bullet they belong to.
 */
function sectionToMarkdown(
  lines: readonly string[],
  indent: string,
  onTitle: (title: string) => void,
): string[] {
  const widths = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
  const strip = widths.length > 0 ? Math.min(...widths) : 0
  // A drawer before the first headline holds the page's properties, which
  // the importer reads only ahead of every block.
  const head: string[] = []
  const out: string[] = []
  let block: 'fence' | 'text' | null = null
  let blockIndent = 0
  let fence = '```'
  let drawer = false
  for (const [i, raw] of lines.entries()) {
    const line = raw.slice(strip).trimEnd()
    const trimmed = line.trim()
    if (block !== null) {
      if (END_RE.test(trimmed)) {
        out.push(indent + (block === 'fence' ? fence : trimmed))
        block = null
      } else if (line === '') {
        out.push('')
      } else {
        const code = line.slice(Math.min(blockIndent, line.length - line.trimStart().length))
        // Org escapes a `*` or `#+` line in a block with a comma.
        out.push(indent + (block === 'fence' ? code.replace(/^(\s*),([*#])/, '$1$2') : line))
      }
      continue
    }
    if (drawer) {
      if (DRAWER_END_RE.test(trimmed)) drawer = false
      else pushDrawerProperty(trimmed, indent, head, out)
      continue
    }
    const titleLine = TITLE_RE.exec(trimmed)
    const begin = BEGIN_RE.exec(trimmed)
    // Org reads a drawer only with its `:END:`; without one it is text.
    if (
      /^:properties:$/i.test(trimmed) &&
      lines.slice(i + 1).some((l) => DRAWER_END_RE.test(l.trim()))
    ) {
      drawer = true
    } else if (titleLine !== null) {
      onTitle((titleLine[1] as string).trim())
    } else if (begin !== null) {
      const kind = (begin[1] as string).toLowerCase()
      block = kind === 'src' || kind === 'example' ? 'fence' : 'text'
      blockIndent = line.length - line.trimStart().length
      fence = fenceFor(lines.slice(i + 1))
      const language = kind === 'src' ? (begin[2] as string) : ''
      out.push(indent + (block === 'fence' ? `${fence}${language}` : trimmed))
    } else if (/^#(?:\s|$)/.test(trimmed)) {
      // An Org comment.
    } else if (PLANNING_RE.test(trimmed)) {
      const planning = trimmed.replace(CLOSED_RE, '').trim()
      if (planning !== '') out.push(indent + planning)
    } else {
      out.push(line === '' ? '' : indent + orgLinks(line))
    }
  }
  if (block === 'fence') out.push(indent + fence)
  return [...head, ...out]
}

/**
 * A drawer's `:key: value` line as `key:: value`: into `head`, the page's
 * properties, before the first headline, else into `out`. A page property the
 * app reserves stays text in `out`, since the import drops it without a word;
 * under a headline the import counts it among the warnings.
 */
function pushDrawerProperty(trimmed: string, indent: string, head: string[], out: string[]): void {
  const property = DRAWER_PROPERTY_RE.exec(trimmed)
  if (property === null || (property[2] as string) === '') return
  const key = property[1] as string
  if (indent !== '') out.push(`${indent}${key}:: ${property[2] as string}`)
  else if (FOLDED_RESERVED_KEYS.has(foldPropertyKey(key))) out.push(trimmed)
  else head.push(`${key}:: ${property[2] as string}`)
}

/**
 * A backtick fence longer than any backtick run in the block opening `rest`,
 * so no line of the code closes it (CommonMark's rule).
 */
function fenceFor(rest: readonly string[]): string {
  const end = rest.findIndex((line) => END_RE.test(line.trim()))
  const code = (end === -1 ? rest : rest.slice(0, end)).join('\n')
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(longest + 1)
}

/**
 * Org links in `text` as Markdown: a URL as `[desc](url)`, a `file:` link as a
 * relative link (to the `.md` page an `.org` file imports as, or an image
 * embed when it has no description), and `[[Page][desc]]` as `[[Page|desc]]`.
 * A link to a heading or an id, and `[[Page]]`, stay as written.
 */
function orgLinks(text: string): string {
  return text.replace(LINK_RE, (whole, target: string, desc: string | undefined) => {
    if (URL_RE.test(target)) return `[${desc ?? target}](${target})`
    const file = /^file:([^:]+)/i.exec(target)
    if (file !== null) {
      const name = file[1] as string
      const path = name.replace(/\.org$/i, '.md').replaceAll(' ', '%20')
      if (desc === undefined && IMAGE_RE.test(path)) return `![](${path})`
      return `[${desc ?? name}](${path})`
    }
    if (desc === undefined || /^[*#]|^\w+:/.test(target)) return whole
    return `[[${target}|${desc}]]`
  })
}
