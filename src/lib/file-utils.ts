/** Simple extension-based MIME type guesser for attachment uploads. */
export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const mimeMap: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    // Documents
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    // Office
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Media
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    // Archives
    zip: 'application/zip',
    tar: 'application/x-tar',
  }
  return mimeMap[ext] || 'application/octet-stream'
}

/**
 * Extract file info from a dropped/pasted File object.
 *
 * `fsPath` is the Tauri-specific `File.path` property — only available
 * when the file is dragged from the OS file manager (not from browser sources).
 * Returns null when unavailable.
 */
export function extractFileInfo(file: File): {
  filename: string
  mimeType: string
  sizeBytes: number
  fsPath: string | null
} {
  const filename = file.name || `pasted-${Date.now()}`
  return {
    filename,
    mimeType: file.type || guessMimeType(filename),
    sizeBytes: file.size,
    fsPath: (file as File & { path?: string }).path ?? null,
  }
}
