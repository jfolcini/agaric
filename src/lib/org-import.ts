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
 *
 * The file's own vocabulary (#6032 N7): a keyword its `#+TODO` lines declare
 * opens a headline as a task, `#+FILETAGS` are the page's tags and a
 * headline's `:tags:` its block's.
 */

import { FOLDED_RESERVED_KEYS, foldPropertyKey } from '@/lib/inline-property-parse'

/** What {@link orgToMarkdown} reads: the `#+TITLE`, if any, the text and its ids. */
export interface OrgPage {
  title: string | null
  markdown: string
  /** The `:ID:` of a drawer before the first headline, the page's. */
  fileId: string | null
  /** The uuid `:ID:`s of headlines: the importer anchors a block by a uuid `id::` only. */
  headlineIds: string[]
}

/** Where an Org link to an `id:` or a file of the pick leads. */
export interface OrgLinkTargets {
  /** By id: `null` for a headline's, referenced as its block, else the title of the page a file-level id names. */
  ids: ReadonlyMap<string, string | null>
  /** By a `file:` link's path: the title of the page the Org file of the pick it names imports as. */
  fileTitle: (path: string) => string | undefined
}

const NO_TARGETS: OrgLinkTargets = { ids: new Map(), fileTitle: () => undefined }

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
const VOCABULARY_RE = /^#\+(?:SEQ_|TYP_)?TODO:(.*)$/i
const FILETAGS_RE = /^#\+FILETAGS:(.*)$/i
/** A headline's tags, `:a:b:` closing it, after a space or as its whole text. */
const HEADLINE_TAGS_RE = /(?:^|[ \t]+):([\p{L}\p{N}\p{M}_@#%:]+):$/u
/** A comment, or a line {@link orgToMarkdown} reads up front. */
const DROPPED_LINE_RE = /^#(?:\s|$)|^#\+(?:(?:SEQ_|TYP_)?TODO|FILETAGS):/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The keywords the importer reads itself: `TASK_KEYWORDS` in agaric-engine's `import.rs`. */
const IMPORTER_KEYWORDS: ReadonlySet<string> = new Set([
  'TODO',
  'LATER',
  'WAITING',
  'WAIT',
  'DOING',
  'NOW',
  'IN-PROGRESS',
  'DONE',
  'CANCELLED',
  'CANCELED',
  'CANCEL',
])

export function orgToMarkdown(org: string, targets: OrgLinkTargets = NO_TARGETS): OrgPage {
  const page: OrgPage = { title: null, markdown: '', fileId: null, headlineIds: [] }
  const lines = org.replace(/\r\n?/g, '\n').split('\n')
  const vocabulary = taskVocabulary(lines)
  const tags = lines.flatMap((line) => {
    const filetags = FILETAGS_RE.exec(line.trim())
    return filetags === null ? [] : (filetags[1] as string).split(/[:\s]+/).filter((t) => t !== '')
  })
  const out = tags.length > 0 ? [`tags:: ${tags.join(', ')}`] : []
  let section: string[] = []
  let indent = ''
  const flush = (): void => {
    out.push(...sectionToMarkdown(section, indent, page, targets))
    section = []
  }
  for (const line of lines) {
    const headline = HEADLINE_RE.exec(line)
    if (headline === null) {
      section.push(line)
      continue
    }
    flush()
    const depth = (headline[1] as string).length
    const text = headlineText((headline[2] as string).trimEnd(), vocabulary, targets)
    out.push(`${'  '.repeat(depth - 1)}- ${text}`)
    indent = '  '.repeat(depth)
  }
  flush()
  page.markdown = `${out.join('\n')}\n`
  return page
}

/**
 * The task keywords of the `#+TODO`, `#+SEQ_TODO` and `#+TYP_TODO` lines, each
 * as the keyword the importer reads for its state. Those before a `|` are open,
 * after it done, and without one the last is done, as Org reads them. Agaric's
 * states are fixed: a keyword the importer reads keeps its state (`NOW` is
 * DOING), and any other open keyword is TODO and done one DONE.
 */
function taskVocabulary(lines: readonly string[]): Map<string, string> {
  const states = new Map<string, string>()
  for (const line of lines) {
    const declared = VOCABULARY_RE.exec(line.trim())
    if (declared === null) continue
    const words = (declared[1] as string).split(/\s+/).filter((word) => word !== '')
    const bar = words.indexOf('|')
    const firstDone = bar === -1 ? words.length - 1 : bar + 1
    for (const [i, word] of words.entries()) {
      if (word === '|') continue
      // `NEXT(n)` and `WAIT(w@/!)` carry a fast-access key and logging.
      const keyword = word.replace(/\(.*\)$/, '')
      if (!IMPORTER_KEYWORDS.has(keyword)) states.set(keyword, i >= firstDone ? 'DONE' : 'TODO')
    }
  }
  return states
}

/**
 * A headline's text as its bullet's: a keyword of the file's `vocabulary` as
 * the one the importer reads, its links as Markdown and its tags as `#[[tag]]`
 * block tags, a form that keeps `@home` and `2024` whole.
 */
function headlineText(
  text: string,
  vocabulary: Map<string, string>,
  targets: OrgLinkTargets,
): string {
  const tagged = HEADLINE_TAGS_RE.exec(text)
  let title = tagged === null ? text : text.slice(0, tagged.index)
  const keyword = title.split(/\s/, 1)[0] as string
  const state = vocabulary.get(keyword)
  if (state !== undefined) title = state + title.slice(keyword.length)
  const tags = (tagged?.[1] ?? '').split(':').filter((tag) => tag !== '')
  return [orgLinks(title, targets), ...tags.map((tag) => `#[[${tag}]]`)]
    .filter((part) => part !== '')
    .join(' ')
}

/**
 * The lines under one headline (or before the first), less their common
 * indent, at the content column `indent` of the bullet they belong to.
 */
function sectionToMarkdown(
  lines: readonly string[],
  indent: string,
  page: OrgPage,
  targets: OrgLinkTargets,
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
      else pushDrawerProperty(trimmed, indent, head, out, page)
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
      page.title ??= (titleLine[1] as string).trim()
    } else if (begin !== null) {
      const kind = (begin[1] as string).toLowerCase()
      block = kind === 'src' || kind === 'example' ? 'fence' : 'text'
      blockIndent = line.length - line.trimStart().length
      fence = fenceFor(lines.slice(i + 1))
      const language = kind === 'src' ? (begin[2] as string) : ''
      out.push(indent + (block === 'fence' ? `${fence}${language}` : trimmed))
    } else if (DROPPED_LINE_RE.test(trimmed)) {
      // An Org comment, or the file's task keywords or tags, read up front.
    } else if (PLANNING_RE.test(trimmed)) {
      const planning = trimmed.replace(CLOSED_RE, '').trim()
      if (planning !== '') out.push(indent + planning)
    } else {
      out.push(line === '' ? '' : indent + orgLinks(line, targets))
    }
  }
  if (block === 'fence') out.push(indent + fence)
  return [...head, ...out]
}

/**
 * A drawer's `:key: value` line as `key:: value`: into `head`, the page's
 * properties, before the first headline, else into `out`. A page property the
 * app reserves stays text in `out`, since the import drops it without a word;
 * under a headline the import counts it among the warnings. An `:ID:` is
 * also recorded in `page`.
 */
function pushDrawerProperty(
  trimmed: string,
  indent: string,
  head: string[],
  out: string[],
  page: OrgPage,
): void {
  const property = DRAWER_PROPERTY_RE.exec(trimmed)
  if (property === null || (property[2] as string) === '') return
  const key = property[1] as string
  if (foldPropertyKey(key) === 'id') {
    const id = property[2] as string
    if (indent === '') page.fileId ??= id
    else if (UUID_RE.test(id)) page.headlineIds.push(id)
  }
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
 * Org links in `text` as Markdown: a URL as `[desc](url)`, a `file:` link to
 * an Org file the pick's `targets` hold as a link to its page, any other as a
 * relative link (to the `.md` page an `.org` file imports as, or an image
 * embed when it has no description), and `[[Page][desc]]` as `[[Page|desc]]`.
 * An `id:` link the pick's `targets` hold is a reference to the headline's
 * block, which carries no description, or a link to the file's page (#6032
 * N4). Any other `id:` link and a link to a heading or a custom id stay text,
 * escaped so the importer reads no page name in them; `[[Page]]` stays as
 * written.
 */
function orgLinks(text: string, targets: OrgLinkTargets): string {
  return text.replace(LINK_RE, (whole, target: string, desc: string | undefined) => {
    if (URL_RE.test(target)) return `[${desc ?? target}](${target})`
    const file = /^file:([^:]+)/i.exec(target)
    if (file !== null) {
      const name = file[1] as string
      const title = targets.fileTitle(name)
      if (title !== undefined) return desc === undefined ? `[[${title}]]` : `[[${title}|${desc}]]`
      const path = name.replace(/\.org$/i, '.md').replaceAll(' ', '%20')
      if (desc === undefined && IMAGE_RE.test(path)) return `![](${path})`
      return `[${desc ?? name}](${path})`
    }
    const id = /^id:(.+)$/.exec(target)?.[1]?.trim()
    const page = id === undefined ? undefined : targets.ids.get(id)
    if (page === null) return `((${id}))`
    if (page !== undefined) return desc === undefined ? `[[${page}]]` : `[[${page}|${desc}]]`
    if (id !== undefined || /^[*#]/.test(target)) return `\\${whole}`
    if (desc === undefined || /^\w+:/.test(target)) return whole
    return `[[${target}|${desc}]]`
  })
}
