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

/**
 * Maximum attachment size accepted by the backend (PEND-76 F2) — 50 MB.
 * Mirrors the Rust-side cap; keep the two in sync.
 */
export const MAX_ATTACHMENT_BYTES = 52_428_800

/**
 * MIME types the backend accepts for bytes-over-IPC attachments (PEND-76 F2).
 * Anything outside this allow-list is rejected server-side; we mirror the
 * check client-side so the UI can fail fast with a clear message instead of
 * round-tripping bytes only to have the IPC reject them.
 *
 * Prefix entries (ending in `/`) match any subtype under that top-level type.
 */
const ALLOWED_MIME_PREFIXES = ['image/', 'text/'] as const
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/json',
  'application/zip',
  'application/x-tar',
] as const

/** Whether a MIME type is on the backend attachment allow-list. */
function isMimeAllowed(mimeType: string): boolean {
  return (
    ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) ||
    (ALLOWED_MIME_EXACT as readonly string[]).includes(mimeType)
  )
}

/**
 * Pure validator mirroring the backend attachment allow-list + size cap
 * (PEND-76 F2). Returns a discriminated result so callers can surface the
 * `reason` directly in a toast.
 *
 * The `reason` strings are i18n keys (resolved by the caller via `t()`).
 * `i18nContext` carries interpolation values for the richer toast copy
 * (filename, size, allowed types — see #218 item 2).
 */
export function isAttachmentAllowed(
  mimeType: string,
  sizeBytes: number,
): { ok: true } | { ok: false; reason: string; i18nContext: Record<string, string> } {
  if (!isMimeAllowed(mimeType)) {
    return {
      ok: false,
      reason: 'blockTree.attachmentTypeNotAllowed',
      i18nContext: { type: mimeType },
    }
  }
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    const mb = (sizeBytes / 1_048_576).toFixed(1)
    return {
      ok: false,
      reason: 'blockTree.attachmentTooLarge',
      i18nContext: { size: `${mb} MB` },
    }
  }
  return { ok: true }
}

/** Read a browser `File` into a `Uint8Array` for bytes-over-IPC upload. */
export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}
