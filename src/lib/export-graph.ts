import JSZip from 'jszip'
import { exportPageMarkdown, listBlocks } from './tauri'

/**
 * Export all pages as a ZIP of markdown files.
 * Each page becomes a .md file named after its content (title).
 * Returns a Blob containing the ZIP.
 *
 * `spaceId` (FEAT-3 Phase 4) — when set, only pages in the active
 * space are included in the export. Pass `null` for the legacy
 * cross-space behaviour. The `?? ''` fallback at the call site is the
 * pre-bootstrap no-match sentinel.
 */
export async function exportGraphAsZip(spaceId: string | null): Promise<Blob> {
  const zip = new JSZip()

  // Load all pages
  const resp = await listBlocks({ blockType: 'page', limit: 1000, spaceId: spaceId ?? '' })
  const pages = resp.items

  // Export each page to markdown
  const seen = new Set<string>()
  for (const page of pages) {
    const md = await exportPageMarkdown(page.id)
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
