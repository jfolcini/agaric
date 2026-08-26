import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { FlushAllDraftsResult } from '@/lib/bindings'

/** Save (upsert) a draft for a block. Called every ~2s during active typing. */
export async function saveDraft(blockId: string, content: string): Promise<void> {
  unwrap(await commands.saveDraft(blockId, content))
}

/**
 * Flush every pending draft in a single `BEGIN IMMEDIATE` tx (
 * Tier 2.12). Used by `useAppBootRecovery` to consolidate boot recovery
 * into one IPC instead of N fire-and-forget per-draft round-trips. The
 * backend semantics are all-or-nothing: a single draft failure rolls
 * back the whole batch — see `flush_all_drafts_inner`'s doc comment.
 */
export async function flushAllDrafts(): Promise<FlushAllDraftsResult> {
  return unwrap(await commands.flushAllDrafts())
}

/** Delete a draft for a block (e.g. after a successful normal save). */
export async function deleteDraft(blockId: string): Promise<void> {
  unwrap(await commands.deleteDraft(blockId))
}

// ---------------------------------------------------------------------------
// Frontend logging (F-19)
// ---------------------------------------------------------------------------
