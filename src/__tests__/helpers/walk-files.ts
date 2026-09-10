import { readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * Every file under `dir` for which `keep(name)` holds, as posix-separated
 * paths — the tree-walking guards compare these against hand-listed baselines,
 * and a raw `path.join` result matches nothing on Windows. `node_modules` is
 * never descended into.
 */
export function walkFiles(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = []
  const visit = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules') visit(full)
      } else if (keep(entry)) {
        out.push(full.split(sep).join('/'))
      }
    }
  }
  visit(dir)
  return out
}
