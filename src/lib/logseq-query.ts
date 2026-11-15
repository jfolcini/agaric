/**
 * A Logseq simple query, `{{query (and (task TODO) [[work]])}}`, as the query
 * block text of the search syntax (#6754), where every clause has an
 * equivalent. Any other stays on the page as a code block holding the macro
 * as written, and is counted so the import can say how many to rebuild.
 *
 * The output is built as a search-query AST and written with the search
 * syntax's own `serialize`, then read back by `parse`: text that does not read
 * back as the filters built (an invalid token, a lost filter) is no
 * translation. So the quoting and the `OR` grammar are never written here.
 *
 * Advanced (Datalog) queries are not macros and are left alone.
 */

import { closesFence, documentFenceOpener, type FenceRun } from '@/editor/source-buffer-document'
import { PRIORITY_LEVELS } from '@/lib/priority-levels'
import { holdsOr, parse, serialize } from '@/lib/search-query'
import type { FilterNode, FilterToken, SearchQueryAST } from '@/lib/search-query/types'

/** The info string of the code block an untranslated query is kept in. */
const KEPT_QUERY_LANGUAGE = 'logseq-query'

/** The first line of that code block, which the editor shows where it does not show the info string. */
const KEPT_QUERY_MARKER = 'Logseq query, not translated:'

/** A bullet, or an unindented line, that is one macro whose expression opens as Logseq's do: group 1 the line's lead, 2 the expression. */
const QUERY_LINE_RE = /^(\s*[-*+]\s+|)\{\{query\s+([("[].*?)\s*\}\}\s*$/i

// content-regex-allow: mirrors the backend's tag-name class, whose first character is a base character on purpose; this only reads names
const TAG_NAME = String.raw`[\p{L}\p{N}_][\p{L}\p{N}\p{M}_/-]*`

/** `#name` and `#[[Name]]` after whitespace, as the backend reads a tag: group 1 the multi-word name, 2 the bare one. */
const INLINE_TAG_RE = new RegExp(String.raw`(?:^|\s)#(?:\[\[([^\]\n]+)\]\]|(${TAG_NAME}))`, 'gu')

/** A `tags:: a, [[b]], #c` line: group 1 its items. */
const TAGS_LINE_RE = /^\s*(?:[-*+]\s+)?tags::[ \t]*(.*)$/gim

/** The keys the backend keeps in native columns, which `prop:` never matches. */
const NATIVE_KEYS = new Set(['todo_state', 'priority', 'due_date', 'scheduled_date', 'space_id'])

/** The state each Logseq task marker imports as. */
const STATES: Readonly<Record<string, string>> = {
  TODO: 'TODO',
  LATER: 'TODO',
  WAIT: 'TODO',
  WAITING: 'TODO',
  DOING: 'DOING',
  NOW: 'DOING',
  'IN-PROGRESS': 'DOING',
  STARTED: 'DOING',
  DONE: 'DONE',
  CANCEL: 'CANCELLED',
  CANCELED: 'CANCELLED',
  CANCELLED: 'CANCELLED',
}

/** The filters a repeat of which OR-combines inside one AND run, so two clauses of one cannot share a run. */
const OR_KINDS = new Set(['state', 'priority', 'pathInclude'])

type Sexp =
  | { k: 'list'; items: Sexp[] }
  | { k: 'atom'; text: string }
  | { k: 'string'; text: string }
  | { k: 'page'; text: string }

type Node =
  | { t: 'filters'; tokens: FilterToken[] }
  | { t: 'word'; text: string }
  | { t: 'and' | 'or'; children: Node[] }

/** A clause with no equivalent. */
class Unsupported extends Error {}

const SEXP_TOKEN_RE = /\s*(?:(\()|(\))|\[\[([^\]]+)\]\]|"([^"]*)"|([^\s()"[\]]+))/y

function readSexp(source: string): Sexp | null {
  SEXP_TOKEN_RE.lastIndex = 0
  const read = (): Sexp => {
    const m = SEXP_TOKEN_RE.exec(source)
    if (m === null || m[2] !== undefined) throw new Unsupported()
    if (m[1] !== undefined) {
      const items: Sexp[] = []
      for (;;) {
        const next = SEXP_TOKEN_RE.exec(source)
        if (next === null) throw new Unsupported()
        if (next[2] !== undefined) return { k: 'list', items }
        SEXP_TOKEN_RE.lastIndex -= next[0].length
        items.push(read())
      }
    }
    if (m[3] !== undefined) return { k: 'page', text: m[3].trim() }
    if (m[4] !== undefined) return { k: 'string', text: m[4] }
    return { k: 'atom', text: m[5] as string }
  }
  try {
    const sexp = read()
    return /^\s*$/.test(source.slice(SEXP_TOKEN_RE.lastIndex)) ? sexp : null
  } catch (err) {
    if (err instanceof Unsupported) return null
    throw err
  }
}

const noSpan: [number, number] = [0, 0]

const filters = (...tokens: FilterToken[]): Node => ({ t: 'filters', tokens })

/** The text of an argument that names one thing: a bare word, a string or a `[[page]]`. */
function argument(sexp: Sexp | undefined): string {
  if (sexp === undefined || sexp.k === 'list' || sexp.text.trim() === '') throw new Unsupported()
  return sexp.text.trim()
}

function atoms(args: Sexp[]): string[] {
  if (args.length === 0) throw new Unsupported()
  return args.map((arg) => {
    if (arg.k !== 'atom') throw new Unsupported()
    return arg.text.toUpperCase()
  })
}

const unique = (values: string[]): string[] => [...new Set(values)]

function taskClause(args: Sexp[]): Node {
  const states = atoms(args).map((marker) => STATES[marker] ?? '')
  if (states.includes('')) throw new Unsupported()
  return filters(
    ...unique(states).map((value): FilterToken => ({ kind: 'state', value, span: noSpan })),
  )
}

function priorityClause(args: Sexp[]): Node {
  const levels = atoms(args).map((letter) => PRIORITY_LEVELS['ABC'.indexOf(letter)] ?? '')
  if (levels.includes('') || args.some((arg) => argument(arg).length !== 1)) throw new Unsupported()
  return filters(
    ...unique(levels).map((value): FilterToken => ({ kind: 'priority', value, span: noSpan })),
  )
}

/** The page named exactly: a glob with no wildcard still matches as a substring, so its first character is a one-character class. */
function pageClause(args: Sexp[]): Node {
  const name = argument(args[0])
  if (args.length !== 1 || /["*?[\]{},\\]/.test(name)) throw new Unsupported()
  const [first = '', ...rest] = name
  return filters({ kind: 'pathInclude', value: `[${first}]${rest.join('')}`, span: noSpan })
}

function propertyClause(args: Sexp[]): Node {
  const key = argument(args[0])
  const value = args.length === 1 ? '' : argument(args[1])
  const nativeKey = NATIVE_KEYS.has(key.toLowerCase().replaceAll('-', '_'))
  // A `[[page]]` value is a ref the query cannot name, and a second value is Logseq's own list form.
  if (args.length > 2 || args[1]?.k === 'page' || nativeKey || /[\s"=]/.test(key)) {
    throw new Unsupported()
  }
  return filters({ kind: 'prop', key, value, span: noSpan })
}

function tagClause(name: string): Node {
  return filters({ kind: 'tag', value: name, span: noSpan })
}

/** `node` as it reads under a `not`: a filter with a `not-` form, or De Morgan over the groups. */
function negate(node: Node): Node {
  switch (node.t) {
    case 'word': {
      throw new Unsupported()
    }
    case 'and': {
      return { t: 'or', children: node.children.map(negate) }
    }
    case 'or': {
      return { t: 'and', children: node.children.map(negate) }
    }
    case 'filters': {
      return filters(
        ...node.tokens.map((token): FilterToken => {
          switch (token.kind) {
            case 'state': {
              return { ...token, kind: 'notState' }
            }
            case 'priority': {
              return { ...token, kind: 'notPriority' }
            }
            case 'pathInclude': {
              return { ...token, kind: 'pathExclude' }
            }
            case 'prop': {
              return { ...token, kind: 'notProp' }
            }
            default: {
              throw new Unsupported()
            }
          }
        }),
      )
    }
  }
}

function clause(sexp: Sexp, tags: ReadonlySet<string>): Node {
  if (sexp.k === 'string') return { t: 'word', text: `"${sexp.text}"` }
  if (sexp.k === 'page') {
    // An inline `#x` is a reference, not an attached tag, and `under:` matches both.
    if (!tags.has(sexp.text.toLowerCase())) throw new Unsupported()
    return filters({ kind: 'under', value: sexp.text, span: noSpan })
  }
  if (sexp.k === 'atom') throw new Unsupported()
  const [head, ...args] = sexp.items
  if (head?.k !== 'atom') throw new Unsupported()
  switch (head.text.toLowerCase()) {
    case 'and':
    case 'or': {
      if (args.length === 0) throw new Unsupported()
      return {
        t: head.text.toLowerCase() === 'and' ? 'and' : 'or',
        children: args.map((arg) => clause(arg, tags)),
      }
    }
    case 'not': {
      if (args.length !== 1) throw new Unsupported()
      return negate(clause(args[0] as Sexp, tags))
    }
    case 'task':
    case 'todo': {
      return taskClause(args)
    }
    case 'priority': {
      return priorityClause(args)
    }
    case 'page': {
      return pageClause(args)
    }
    case 'page-tags': {
      if (args.length !== 1) throw new Unsupported()
      return tagClause(argument(args[0]))
    }
    case 'property':
    case 'page-property': {
      return propertyClause(args)
    }
    default: {
      // `between`, `namespace`, `sort-by`, `sample` and the rest have no filter.
      throw new Unsupported()
    }
  }
}

/** The filter kinds `node` holds. */
function kindsOf(node: Node): string[] {
  if (node.t === 'word') return []
  if (node.t === 'filters') return node.tokens.map((token) => token.kind)
  return node.children.flatMap(kindsOf)
}

/** `node` flattened, each AND run checked for a kind that would OR across two clauses. */
function normalise(node: Node): Node {
  if (node.t === 'filters' || node.t === 'word') return node
  const children = node.children.flatMap((child) => {
    const inner = normalise(child)
    return inner.t === node.t ? inner.children : [inner]
  })
  if (node.t === 'and') {
    const seen = new Set<string>()
    for (const child of children) {
      for (const kind of new Set(kindsOf(child))) {
        if (OR_KINDS.has(kind) && seen.has(kind)) throw new Unsupported()
        seen.add(kind)
      }
    }
  }
  return children.length === 1 ? (children[0] as Node) : { t: node.t, children }
}

function holdsWord(node: Node): boolean {
  if (node.t === 'word') return true
  return node.t !== 'filters' && node.children.some(holdsWord)
}

/** The AST of `node`: words only at the top, as free text beside the filters. */
function toAst(node: Node): SearchQueryAST {
  const top = node.t === 'and' ? node.children : [node]
  const words = top.flatMap((child) => (child.t === 'word' ? [child.text] : []))
  const rest = top.filter((child) => child.t !== 'word')
  if (rest.some(holdsWord)) throw new Unsupported()
  const list: FilterToken[] = []
  const tree = (n: Node): FilterNode => {
    if (n.t === 'word') throw new Unsupported()
    if (n.t === 'filters') {
      const nodes = n.tokens.map((token): FilterNode => {
        list.push(token)
        return { kind: 'token', index: list.length - 1 }
      })
      return nodes.length === 1 ? (nodes[0] as FilterNode) : { kind: 'and', children: nodes }
    }
    return { kind: n.t, children: n.children.map(tree) }
  }
  const expr =
    rest.length === 0
      ? undefined
      : tree(rest.length === 1 ? (rest[0] as Node) : { t: 'and', children: rest })
  const ast: SearchQueryAST = { filters: list, freeText: words.join(' ') }
  return expr !== undefined && holdsOr(expr) ? { ...ast, expr } : ast
}

/**
 * The query block text, `{{query …}}`, that `expression` (the text between
 * `{{query ` and `}}`) translates to, or null when a clause has no
 * equivalent. `tags` holds the lowercased names the import makes tags, which
 * a `[[name]]` clause needs, since only a tag is a filter (`under:`, which sees inline `#name`).
 */
export function translateLogseqQuery(expression: string, tags: ReadonlySet<string>): string | null {
  try {
    const sexp = readSexp(expression)
    if (sexp === null) return null
    const ast = toAst(normalise(clause(sexp, tags)))
    const text = serialize(ast)
    const back = parse(text)
    const lost =
      back.filters.length !== ast.filters.length ||
      back.filters.some((token) => token.kind === 'invalid') ||
      back.freeText !== ast.freeText
    return lost ? null : `{{query ${text}}}`
  } catch (err) {
    if (err instanceof Unsupported) return null
    throw err
  }
}

/** The lowercased names `content` makes tags: its `#name` and `#[[Name]]`, and the items of its `tags::` lines. */
export function logseqTagNames(content: string): string[] {
  const names: string[] = []
  for (const [, multiWord, bare] of content.matchAll(INLINE_TAG_RE)) {
    const name = (multiWord ?? bare) as string
    if (/\D/.test(name)) names.push(name.trim().toLowerCase())
  }
  for (const [, items] of content.matchAll(TAGS_LINE_RE)) {
    for (const item of (items as string).split(',')) {
      const name = item.replace(/^\s*#?(?:\[\[)?|(?:\]\])?\s*$/g, '').toLowerCase()
      if (name !== '') names.push(name)
    }
  }
  return names
}

/** Whether `content` may hold a macro this module reads. */
export const holdsLogseqQuery = (content: string): boolean => /\{\{query\s/i.test(content)

/**
 * `content` with each line that is one Logseq `{{query …}}` macro, outside a
 * code fence, translated or, with no equivalent, kept in a code block of
 * {@link KEPT_QUERY_LANGUAGE}; `kept` counts the second. A macro within a
 * line's other text, and a query already in the search syntax, stay as they are.
 */
export function translateLogseqQueries(
  content: string,
  tags: ReadonlySet<string>,
): { content: string; kept: number } {
  let fence: FenceRun | null = null
  let kept = 0
  const lines = content.split('\n').map((line) => {
    const before = fence
    if (fence === null) fence = documentFenceOpener(line)
    else if (closesFence(line, fence)) fence = null
    if (before !== null || fence !== null) return line
    const match = QUERY_LINE_RE.exec(line)
    if (match === null) return line
    const [, lead = '', expression = ''] = match
    const translated = translateLogseqQuery(expression, tags)
    if (translated !== null) return `${lead}${translated}`
    kept += 1
    const column = ' '.repeat(lead.length)
    return `${lead}\`\`\`${KEPT_QUERY_LANGUAGE}\n${column}${KEPT_QUERY_MARKER}\n${column}{{query ${expression}}}\n${column}\`\`\``
  })
  return { content: lines.join('\n'), kept }
}
