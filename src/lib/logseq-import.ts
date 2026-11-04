/**
 * A Logseq graph folder as the pages a folder import makes (#6033).
 *
 * Logseq names a page by its file name alone, never its folder: a namespace
 * `a/b` is the file `pages/a___b.md` (`a.b.md` in the legacy file-name
 * format), and a name's other reserved characters are percent-encoded
 * (`What%3F.md`). A journal is `journals/<day>.md` in the graph's
 * `:journal/file-name-format` and is linked by its title in
 * `:journal/page-title-format` (`[[Oct 21st, 2026]]`), while Agaric's journal
 * page for a day is titled `YYYY-MM-DD`. Both formats are date-fns patterns
 * as Logseq writes them.
 */

import { format, isValid, parse } from 'date-fns'

import { closesFence, documentFenceOpener, type FenceRun } from '@/editor/source-buffer-document'
import { logger } from '@/lib/logger'

/** The vault-relative path of a graph's config. */
export const LOGSEQ_CONFIG = 'logseq/config.edn'

/** Agaric's journal page title for a day. */
const JOURNAL_TITLE = 'yyyy-MM-dd'

/** A `[[Name]]` link: group 1 is its name. */
const PAGE_LINK_RE = /\[\[([^\]\n]+)\]\]/g

/** A run of percent-encoded bytes, decoded together so a multi-byte character reads whole. */
const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g

/** A page property line `key:: value` of the lines a Logseq page opens with. */
const PAGE_PROPERTY_RE = /^([A-Za-z0-9_-]+)::(.*)$/

/**
 * Whether the vault-relative paths of a pick read as a Logseq graph: it holds
 * `logseq/config.edn`, or both `pages/` and `journals/` at its root.
 */
export function isLogseqGraph(paths: readonly string[]): boolean {
  return (
    paths.includes(LOGSEQ_CONFIG) ||
    (paths.some((p) => p.startsWith('pages/')) && paths.some((p) => p.startsWith('journals/')))
  )
}

/**
 * Whether a graph's file is Logseq's own, under `logseq/`, never a page: its
 * `bak/` and `version-files/` copies of pages would import as twins.
 */
export function isLogseqAppFile(path: string): boolean {
  return path.startsWith('logseq/')
}

/** The string value `config.edn` gives `key` on a line of its own, outside a `;` comment. */
function setting(edn: string, key: string): string | undefined {
  return new RegExp(`^[ \\t{,]*:${key}[ \\t]+"([^"\\n]*)"`, 'm').exec(edn)?.[1]
}

/** `stem` with each `%XX` run decoded; a run that is no UTF-8 stays as written. */
function percentDecode(stem: string): string {
  return stem.replace(PERCENT_RUN_RE, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** The day a journal's file stem names in `fileFormat`, written back the same, or null. */
function journalDay(stem: string, fileFormat: string): Date | null {
  try {
    const day = parse(stem, fileFormat, new Date(0))
    return isValid(day) && format(day, fileFormat) === stem ? day : null
  } catch {
    return null
  }
}

/**
 * Each day's Logseq journal title, lowercased as Logseq matches names, to the
 * day's `YYYY-MM-DD` title. Empty, with one warning, when date-fns cannot
 * write `titleFormat`.
 */
function journalLinks(days: readonly Date[], titleFormat: string): Map<string, string> {
  try {
    return new Map(
      days.map((day) => [format(day, titleFormat).toLowerCase(), format(day, JOURNAL_TITLE)]),
    )
  } catch (err) {
    logger.warn(
      'logseq-import',
      'journal links left as written: the journal title format is not one date-fns writes',
      { titleFormat },
      err,
    )
    return new Map()
  }
}

/** A Logseq graph's page titles and journal links. */
export interface LogseqGraph {
  /** The page title each path imports as, in order; null outside `pages/` and `journals/`. */
  titles: (string | null)[]
  /** `content` with each link naming a journal by its Logseq title naming its day instead. */
  rewrite: (content: string) => string
}

/**
 * The graph whose `logseq/config.edn` reads `edn` (null when it has none) and
 * whose notes sit at the vault-relative `paths`.
 */
export function logseqGraph(edn: string | null, paths: readonly string[]): LogseqGraph {
  const fileFormat = setting(edn ?? '', 'journal/file-name-format') ?? 'yyyy_MM_dd'
  const titleFormat = setting(edn ?? '', 'journal/page-title-format') ?? 'MMM do, yyyy'
  const legacy = edn !== null && !/^[ \t{,]*:file\/name-format[ \t]+:triple-lowbar\b/m.test(edn)
  const days: Date[] = []
  const titles = paths.map((path) => {
    const folder = path.slice(0, path.indexOf('/') + 1)
    if (folder !== 'pages/' && folder !== 'journals/') return null
    const name = path.slice(path.lastIndexOf('/') + 1)
    const stem = name.slice(0, name.lastIndexOf('.'))
    const day = folder === 'journals/' ? journalDay(stem, fileFormat) : null
    if (day !== null) days.push(day)
    return day !== null
      ? format(day, JOURNAL_TITLE)
      : percentDecode(stem.replaceAll(legacy ? '.' : '___', '/'))
  })
  const links = journalLinks(days, titleFormat)
  return { titles, rewrite: (content) => rewriteLinks(content, links) }
}

/** `content` with each `[[Name]]` outside a code fence that `links` names linking its day. */
function rewriteLinks(content: string, links: ReadonlyMap<string, string>): string {
  if (links.size === 0) return content
  let fence: FenceRun | null = null
  return content
    .split('\n')
    .map((line) => {
      const before = fence
      if (fence === null) fence = documentFenceOpener(line)
      else if (closesFence(line, fence)) fence = null
      if (before !== null || fence !== null) return line
      return line.replace(PAGE_LINK_RE, (link, name: string) => {
        const day = links.get(name.trim().toLowerCase())
        return day === undefined ? link : `[[${day}]]`
      })
    })
    .join('\n')
}

/**
 * The `title::` a Logseq page names itself by among the property lines it
 * opens with, which Logseq prefers to its file name; null when it has none.
 */
export function logseqTitleProperty(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = PAGE_PROPERTY_RE.exec(line.trimEnd())
    if (match === null) return null
    if ((match[1] as string).toLowerCase() === 'title') return (match[2] as string).trim() || null
  }
  return null
}
