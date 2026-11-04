// #5986 — the accepted-equivalent mutant record, `mutation-accepted.tsv`: how a
// frontend mutant is fingerprinted and how the file is parsed. Shared by the
// weekly filer (`file-mutation-survivors.mjs`) and the summary renderer
// (`render-mutation-summary.mjs`) so a PR's comment and the tracking issue
// subtract the same set. No import-time work: the renderer must never fail.

/**
 * The line-independent identity of a frontend mutant: file, mutator, the
 * trimmed text of its source line, its column relative to that text, and which
 * occurrence of that text it is in the file. `lines` is the file's source and
 * `line` is 1-based. `undefined` when the line cannot be read.
 */
export function frontendKey(file, mutator, lines, line, column) {
  const raw = lines[line - 1]
  const text = raw?.trim()
  if (!text) return undefined
  const relativeColumn = column - (raw.length - raw.trimStart().length)
  let occurrence = 1
  for (let i = 0; i < line - 1; i++) if (lines[i].trim() === text) occurrence++
  return ['frontend', file, mutator, relativeColumn, occurrence, text].join('\t')
}

const ACCEPTED_ENTRY_SHAPE = {
  frontend: /^frontend\t[^\t]+\t[^\t]+\t-?\d+\t[1-9]\d*\t\S/,
  rust: /^rust\t[^\t]+\t[^\t]+\t\S/,
}

/**
 * The fingerprints in `mutation-accepted.tsv`. Blank lines and `#` comments are
 * skipped; anything else that is not an entry throws, so a bad paste fails the
 * lane instead of silently suppressing nothing.
 */
export function parseAcceptedFile(text, where = 'mutation-accepted.tsv') {
  const keys = new Set()
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const lane = line.split('\t', 1)[0]
    if (!ACCEPTED_ENTRY_SHAPE[lane]?.test(line) || line !== line.trimEnd())
      throw new Error(
        `${where}:${i + 1}: not an accepted-equivalent entry: ${JSON.stringify(line)}`,
      )
    keys.add(line)
  }
  return keys
}
