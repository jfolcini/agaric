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
  return 'paragraph'
}

/**
 * Read the inline text out of `content`, stripping whatever block marker the
 * first line currently carries (or unwrapping a fenced code block).
 */
function firstLineText(content: string): string {
  const lines = content.split('\n')
  if (FENCE_RE.test((lines[0] ?? '').trimStart())) {
    const inner = content.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
    return inner.split('\n')[0] ?? ''
  }
  return stripBlockMarker(lines[0] ?? '')
}

/**
 * Convert `content` to the target block `type`, returning the new markdown.
 * Operates on the first line's marker; preserves the inline text.
 */
export function convertBlockContent(content: string, type: BlockTypeToken): string {
  if (type === 'code') {
    // Wrap the (marker-stripped) content in a fenced code block. If it is
    // already fenced, leave it as-is.
    if (FENCE_RE.test(content.trimStart())) return content
    const body = stripBlockMarker(content.split('\n')[0] ?? '')
    const rest = content.split('\n').slice(1)
    return `\`\`\`\n${[body, ...rest].join('\n')}\n\`\`\``
  }

  const text = firstLineText(content)
  switch (type) {
    case 'paragraph':
      return text
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number.parseInt(type.slice(1), 10)
      return `${'#'.repeat(level)} ${text}`
    }
    case 'quote':
      return `> ${text}`
    case 'numbered-list':
      return `1. ${text}`
    case 'callout':
      return `> [!INFO] ${text}`
    default:
      return content
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
    case 'callout':
      return token
    default:
      return null
  }
}
