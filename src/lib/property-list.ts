/**
 * A list value (#6741) as one line of text: `key:: Smith, "Doe, Jane", [[Page, One]]`.
 * Typed in a block, written by Edit as Markdown and read back by Duplicate. Rust reads and
 * writes the same text (`import::property_list_items`, `import::write_property_list`).
 */

/**
 * The items of `value`, a list's text: split at each comma outside `[[…]]` and outside a
 * double-quoted item, each trimmed, a quoted item read as a JSON string, blanks dropped.
 */
export function splitListItems(value: string): string[] {
  const items: string[] = []
  const flush = (item: string): void => {
    const read = readItem(item.trim())
    if (read.trim() !== '') items.push(read)
  }
  let item = ''
  let depth = 0
  let quoted = false
  let escaped = false
  for (const c of value) {
    if (quoted) {
      item += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === ',' && depth === 0) {
      flush(item)
      item = ''
      continue
    }
    if (c === '[') depth += 1
    else if (c === ']') depth = Math.max(0, depth - 1)
    else if (c === '"' && item.trim() === '') quoted = true
    item += c
  }
  flush(item)
  return items
}

/** A quoted item's string, or the item as written when it is not one JSON string. */
function readItem(item: string): string {
  if (!item.startsWith('"')) return item
  try {
    const read: unknown = JSON.parse(item)
    return typeof read === 'string' ? read : item
  } catch {
    // An unclosed or malformed quote is text the user typed, kept as written.
    return item
  }
}

/**
 * The text of `items`, joined by `, `: an item that holds a comma, a double quote or a line break,
 * begins or ends with whitespace, or leaves a `[` open, which would take the next comma, is
 * written as a JSON string.
 */
export function joinListItems(items: readonly string[]): string {
  return items
    .map((item) =>
      /[,"\n\r]|^\s|\s$/.test(item) || leavesBracketOpen(item) ? JSON.stringify(item) : item,
    )
    .join(', ')
}

function leavesBracketOpen(item: string): boolean {
  let depth = 0
  for (const c of item) {
    if (c === '[') depth += 1
    else if (c === ']') depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

/** Rust's `f64` grammar: a sign, digits with an optional point, an optional exponent. */
export const RUST_F64 = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/**
 * `text` as a number the way Rust reads one (`f64::from_str`) and keeps it (finite only), or
 * null: `Number` alone would also take `0x10`, `Infinity` and the empty string.
 */
export function readFiniteNumber(text: string): number | null {
  const n = Number(text)
  return RUST_F64.test(text) && Number.isFinite(n) ? n : null
}
