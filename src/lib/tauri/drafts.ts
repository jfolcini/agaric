import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { Draft, FlushAllDraftsResult, MdnsStatus, RecoveryStatus } from '@/lib/bindings'

/** Save (upsert) a draft for a block. Called every ~2s during active typing. */
export async function saveDraft(blockId: string, content: string): Promise<void> {
  unwrap(await commands.saveDraft(blockId, content))
}

/** Flush a draft: write an edit_block op and delete the draft row. Called on blur/unmount. */
export async function flushDraft(blockId: string): Promise<void> {
  unwrap(await commands.flushDraft(blockId))
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

/**
 * #1255: read the boot-recovery status. Used by `useRecoveryStatus` to
 * backfill the degraded-boot signal on mount — boot runs (and emits
 * `recovery:degraded`) before the webview registers its listener, so the
 * live event can be missed. `degraded === true` means the C-2b op-log
 * replay failed and the materialized view may be incomplete/stale (the op
 * log is canonical — nothing is lost). Mirrors the `useDeepLinkRouter` +
 * `getCurrentDeepLink()` "emit + query-on-mount backfill" shape.
 */
export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  return unwrap(await commands.getRecoveryStatus())
}

/**
 * #2506: read the current mDNS peer-discovery status. Used by
 * `useMdnsStatus` to backfill the "discovery unavailable" signal on
 * mount — the sync daemon can emit `sync:mdns_disabled` before the
 * webview registers its listener (same boot race `getRecoveryStatus`
 * covers for `recovery:degraded`), so the live event can be missed.
 */
export async function getMdnsStatus(): Promise<MdnsStatus> {
  return unwrap(await commands.getMdnsStatus())
}

/** Delete a draft for a block (e.g. after a successful normal save). */
export async function deleteDraft(blockId: string): Promise<void> {
  unwrap(await commands.deleteDraft(blockId))
}

/** List all drafts, ordered by updated_at ascending. */
export async function listDrafts(): Promise<Draft[]> {
  return unwrap(await commands.listDrafts())
}

// ---------------------------------------------------------------------------
// Frontend logging (F-19)
// ---------------------------------------------------------------------------
