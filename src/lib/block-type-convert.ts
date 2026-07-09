/**
 * #264 — block-type conversion ("Turn into").
 *
 * Single source of truth for converting a block's markdown content from one
 * structural type to another. Shared by:
 *   - the `/turn` slash family (`useSlashCommandStructural`), which converts
 *     the focused block's content, and
 *   - the "Turn into ▸" group in the block context-menu, which converts the
 *     right-clicked / long-pressed block (which may not be the focused one).
 *
 * The conversion operates on the block's markdown content — the same
 * read-modify-write the existing structural slash handlers use via
 * `applyContentEdit` (e.g. `# ` for headings, `> ` for quotes, `1. ` for
 * ordered lists). This is NOT a destructive whole-block mass-convert: it
 * strips the leading block marker of the first line and applies the new one,
 * leaving the inline text intact. Code-block conversion uses fenced
 * ``` syntax so it round-trips through the markdown parser/serializer like
 * any other block.
 */

/** Canonical block-type tokens used by the Turn-into menu. */
export type BlockTypeToken =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'quote'
  | 'code'
  | 'numbered-list'
  | 'bullet-list'
  | 'callout'

const HEADING_RE = /^(#{1,6})\s+/
// Plain blockquote: `> ` not followed by a `[!` callout marker.
const QUOTE_RE = /^>\s+(?!\[!)/
const CALLOUT_RE = /^>\s+\[![A-Za-z]+\]\s*/
const ORDERED_RE = /^\d+\.\s+/
const BULLET_RE = /^[-*+]\s+/
const FENCE_RE = /^```/

/**
 * Strip the leading structural marker from a single line of markdown,
 * returning the bare inline text. Idempotent for already-plain text.
 */
export function stripBlockMarker(line: string): string {
  return line
    .replace(CALLOUT_RE, '')
    .replace(HEADING_RE, '')
    .replace(QUOTE_RE, '')
    .replace(ORDERED_RE, '')
    .replace(BULLET_RE, '')
}

/**
 * Detect the current block type from the first non-empty line of `content`.
 * Used to highlight the active type in the Turn-into menu. Falls back to
 * `'paragraph'` for plain text or unrecognised content.
 */
export function detectBlockType(content: string): BlockTypeToken {
  const line = content.split('\n').find((l) => l.trim() !== '') ?? ''
  if (FENCE_RE.test(line.trimStart())) return 'code'
  if (CALLOUT_RE.test(line)) return 'callout'
  const heading = line.match(HEADING_RE)
  if (heading) {
    const level = (heading[1] as string).length
    return `h${level}` as BlockTypeToken
  }
  if (QUOTE_RE.test(line)) return 'quote'
  if (ORDERED_RE.test(line)) return 'numbered-list'
  if (BULLET_RE.test(line)) return 'bullet-list'
  return 'paragraph'
}

/**
 * Read the inline text lines out of `content`, stripping whatever block
 * marker the first line currently carries (or unwrapping a fenced code
 * block). Quote/callout markers repeat on every line, so continuation lines
 * shed their `> ` prefix too; all other content keeps its trailing lines
 * verbatim so multi-line blocks (code fences, tables, math) never lose text.
 */
function extractLines(content: string): string[] {
  const lines = content.split('\n')
  const first = lines[0] ?? ''
  if (FENCE_RE.test(first.trimStart())) {
    const inner = content.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
    return inner.split('\n')
  }
  const rest = lines.slice(1)
  if (QUOTE_RE.test(first) || CALLOUT_RE.test(first)) {
    return [stripBlockMarker(first), ...rest.map((l) => l.replace(/^>\s?/, ''))]
  }
  return [stripBlockMarker(first), ...rest]
}

/**
 * Convert `content` to the target block `type`, returning the new markdown.
 * Re-marks the first line and preserves every trailing line: quote/callout
 * targets re-mark each line (so the whole block stays inside the quote);
 * other targets keep the tail verbatim (markdown lazy continuation keeps it
 * attached to list items).
 */
export function convertBlockContent(content: string, type: BlockTypeToken): string {
  if (type === 'code') {
    // Wrap the (marker-stripped) content in a fenced code block. If it is
    // already fenced, leave it as-is.
    if (FENCE_RE.test(content.trimStart())) return content
    return `\`\`\`\n${extractLines(content).join('\n')}\n\`\`\``
  }

  const [text = '', ...rest] = extractLines(content)
  const tail = rest.length > 0 ? `\n${rest.join('\n')}` : ''
  switch (type) {
    case 'paragraph': {
      return `${text}${tail}`
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number.parseInt(type.slice(1), 10)
      return `${'#'.repeat(level)} ${text}${tail}`
    }
    case 'quote': {
      return [text, ...rest].map((l) => `> ${l}`).join('\n')
    }
    case 'numbered-list': {
      return `1. ${text}${tail}`
    }
    case 'bullet-list': {
      return `- ${text}${tail}`
    }
    case 'callout': {
      return [`> [!INFO] ${text}`, ...rest.map((l) => `> ${l}`)].join('\n')
    }
    default: {
      return content
    }
  }
}

/** Map a `turn-<type>` picker/menu id to its block-type token (or null). */
export function turnIdToBlockType(id: string): BlockTypeToken | null {
  if (!id.startsWith('turn-')) return null
  const token = id.slice('turn-'.length)
  switch (token) {
    case 'paragraph':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'quote':
    case 'code':
    case 'numbered-list':
    case 'bullet-list':
    case 'callout': {
      return token
    }
    default: {
      return null
    }
  }
}
