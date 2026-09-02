/**
 * `{{embed …}}` block-content token — parse / build (#4550, phase 1).
 *
 * An embed is stored as block-content markup, exactly the way `{{query …}}`
 * is: no migration, no op type, no store. That is what buys backlinks for
 * free — `reindex_block_links_conn` already parses every `((ULID))` /
 * `[[ULID]]` in a block's content via `ULID_LINK_RE`
 * (`src-tauri/agaric-store/src/cache/mod.rs`), so the inner token of an embed
 * produces a link edge, a backlink and a `pages_cache` inbound count with
 * zero backend work.
 *
 * Both delimiter forms are accepted on READ:
 *   - `{{embed ((ULID))}}` — a block target
 *   - `{{embed [[ULID]]}}` — a page target
 *
 * They are not two features. A page *is* a block in this data model
 * (`rootParentId` is a block id), so one renderer serves both and the parse
 * result carries no "kind" discriminator. The pickers always WRITE the
 * `((ULID))` form ({@link buildEmbedToken}); the `[[ULID]]` form exists so
 * hand-written and Logseq-flavoured syntax still renders.
 */

/**
 * Cheap prefix used by the `StaticBlock` content sniff, mirroring the
 * `'{{query '` sniff it sits next to. A block whose content starts with this
 * and ends with `}}` is a *candidate*; {@link parseEmbedToken} is the
 * authority on whether it is actually well-formed.
 */
export const EMBED_TOKEN_PREFIX = '{{embed '

/**
 * How many embed boundaries a render path may cross before the depth stub
 * takes over.
 *
 * **This is a VISUAL bound and has no relationship to `MAX_BLOCK_DEPTH`**
 * (`src/lib/tree-utils.ts`, mirroring the Rust `MAX_BLOCK_DEPTH = 20`), which
 * bounds STORAGE depth per page and bounds nothing an embed does: an embed at
 * storage depth 19 of page A whose target sits at storage depth 19 of page B
 * renders 38 levels of nesting while violating no invariant anywhere. Do not
 * "unify" the two constants — they measure different things, and the product
 * of them (60 levels at this cap) is precisely why the embedded subtree
 * re-bases its indentation to depth 0 inside its container.
 *
 * A safety rail, not a measured cliff.
 */
export const MAX_EMBED_DEPTH = 3

/**
 * Rows rendered eagerly inside one embed before the *open the source*
 * boundary row takes over. The host list's own `INITIAL_MOUNT_LIMIT = 500`
 * bounds the HOST rows only; an embed's rows are additional fibers outside
 * that ceiling, so they get their own, much tighter envelope.
 *
 * A safety rail, not a measured cliff.
 */
export const EMBED_MOUNT_LIMIT = 32

/**
 * Well-formed embed token. Anchored: the token must be the block's ENTIRE
 * content, matching the `{{query …}}` precedent where the whole block is
 * taken over by the render. `[^\s()\[\]]` keeps the id opaque here — the
 * resolve path is the authority on whether it names anything.
 */
const EMBED_TOKEN_RE = /^\{\{embed\s+(?:\(\(([^\s()]+)\)\)|\[\[([^\s[\]]+)\]\])\s*\}\}$/

/** The id an embed token points at. */
export interface EmbedToken {
  /** The target block/page ULID, verbatim from the token. */
  targetId: string
}

/**
 * Parse a block's content as an embed token. Returns `null` for anything
 * that is not exactly one well-formed `{{embed …}}` — including a block that
 * merely *starts* with the prefix, so a half-typed token renders as the text
 * it currently is rather than as a broken embed.
 */
export function parseEmbedToken(content: string | null | undefined): EmbedToken | null {
  if (content == null) return null
  const trimmed = content.trim()
  // Cheap reject before the regex: the vast majority of blocks are not embeds.
  if (!trimmed.startsWith(EMBED_TOKEN_PREFIX) || !trimmed.endsWith('}}')) return null
  const match = EMBED_TOKEN_RE.exec(trimmed)
  if (!match) return null
  const targetId = match[1] ?? match[2]
  if (!targetId) return null
  return { targetId }
}

/**
 * Build the token a picker writes into block content. Always the `((ULID))`
 * form — see the module docstring for why the page/block distinction does not
 * survive into storage.
 */
export function buildEmbedToken(targetId: string): string {
  return `{{embed ((${targetId}))}}`
}
