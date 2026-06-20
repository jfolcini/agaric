/**
 * Attachment-ref scheme for inline images (#1434).
 *
 * When an image is pasted / dropped into a block its bytes are stored as an
 * attachment (the backend is the sole writer; see `addAttachmentWithBytes`) and
 * the editor inserts an INLINE image node that references it by id. The image
 * node's `src` carries an internal "attachment ref" of the form:
 *
 *   attachment:<ULID>
 *
 * where `<ULID>` is the `AttachmentRow.id`. This ref is what the markdown
 * serializer emits inside `![alt](attachment:<id>)`, so an inline pasted image
 * round-trips losslessly through markdown (the URL is opaque to the
 * parser/serializer — it never base64-inlines the bytes into the document).
 *
 * At render time `GatedImage` resolves the ref back to the attachment's bytes
 * (`readAttachment` → `Blob` → object URL). The bytes never live in the markdown
 * — only the id does — which keeps blocks small and lets the backend stay the
 * single source of truth for the file.
 *
 * `attachment:` is deliberately a custom scheme (not `asset:`/`tauri:`) so the
 * resolution is explicit and testable, and so the external-image privacy policy
 * (#1492) treats it as a trusted local src that never needs the network.
 */

/** The scheme prefix that marks an internal attachment reference. */
export const ATTACHMENT_REF_SCHEME = 'attachment:'

/**
 * An attachment id (ULID) is a ref-safe token: it never contains a `)` or
 * whitespace, so `![alt](attachment:<id>)` needs no URL escaping and parses back
 * cleanly. We still validate the shape on resolve so a malformed/hostile ref
 * (e.g. `attachment:../../etc`) is rejected rather than forwarded to the backend.
 */
const ATTACHMENT_ID_PATTERN = /^[0-9A-Za-z_-]+$/

/** Build the inline-image `src` ref for an attachment id. */
export function attachmentRef(attachmentId: string): string {
  return `${ATTACHMENT_REF_SCHEME}${attachmentId}`
}

/** Whether `src` is an `attachment:<id>` ref (any non-empty tail). */
export function isAttachmentRef(src: string): boolean {
  return src.startsWith(ATTACHMENT_REF_SCHEME) && src.length > ATTACHMENT_REF_SCHEME.length
}

/**
 * Extract the attachment id from an `attachment:<id>` ref, or `null` when `src`
 * is not a well-formed ref (wrong scheme, empty id, or an id carrying characters
 * a real attachment ULID never has — path traversal, query, etc.).
 */
export function parseAttachmentRef(src: string): string | null {
  if (!src.startsWith(ATTACHMENT_REF_SCHEME)) return null
  const id = src.slice(ATTACHMENT_REF_SCHEME.length)
  if (id.length === 0 || !ATTACHMENT_ID_PATTERN.test(id)) return null
  return id
}
