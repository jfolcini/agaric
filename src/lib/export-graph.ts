import JSZip from 'jszip'
import { logger } from './logger'
import { exportPageMarkdown, listAllPagesInSpace } from './tauri'

/**
 * Export all pages as a ZIP of markdown files.
 * Each page becomes a .md file named after its content (title).
 * Returns a Blob containing the ZIP.
 *
 * `spaceId` (FEAT-3 Phase 4) — only pages in the active space are
 * included in the export.  The `?? ''` fallback at the call site is
 * the pre-bootstrap no-match sentinel; `listAllPagesInSpace('')`
 * returns an empty list.
 */
export async function exportGraphAsZip(spaceId: string | null): Promise<Blob> {
  const zip = new JSZip()

  // Load every page in the space.  `listAllPagesInSpace` returns every
  // page in one query (no pagination, no clamp) — bounded by the
  // space's intrinsic page count, which is what the export needs.
  const pages = await listAllPagesInSpace(spaceId ?? '')

  // Export each page to markdown. Per-page failures are logged and skipped so a
  // single broken page does not reject the whole export — partial output is more
  // useful than none.
  const seen = new Set<string>()
  for (const page of pages) {
    let md: string
    try {
      md = await exportPageMarkdown(page.id)
    } catch (err) {
      logger.warn('export-graph', 'page export failed', { pageId: page.id }, err)
      continue
    }
    // Sanitize filename: replace invalid chars, ensure uniqueness
    let name = (page.content ?? 'Untitled').replace(/[/\\:*?"<>|]/g, '_').trim() || 'Untitled'
    if (seen.has(name)) {
      name = `${name}_${page.id.slice(0, 8)}`
    }
    seen.add(name)
    zip.file(`${name}.md`, md)
  }

  return zip.generateAsync({ type: 'blob' })
}

/**
 * Trigger a browser download of a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
