# Session 1012 — Phase A: frontend store-race / data-safety trio (#824/#826/#853)

First batch of the post-backlog-review Phase A (data-safety). Three verified data-mutating
store-race guards, each mirroring a cited prior fix; each test fails without the guard.

- **#824** `stores/page-blocks.ts` `edit` rollback — on IPC failure the rollback restored
  pre-edit content unconditionally, clobbering newer typed text. Now guards `cur.content ===
  content` inside the functional updater (the #753 echo pattern) — newer text survives, toast
  still fires.
- **#826** `components/journal/UnfinishedTasks.tsx` catch — a stale/slow rejection reset blocks
  unconditionally. Now `if (!stale) setBlocks([])` reusing the effect's existing `stale` ref
  (the #757 contract).
- **#853** `hooks/useBlockResolve.ts` — a `searchPages` response from the OLD space could seed
  the resolve store after a space switch. Now captures `requestSpaceId` and bails before
  `batchSet` if the active space changed (the #732 captured-space pattern).

258 tests pass, tsc clean. Closes #824 #826 #853.

Part of the backlog review (2026-06-11): closed 18 stale issues (#763/#666/#532/#90 + 12
polish/search + 6 mobile-search → #899 tracker); #215 re-scoped (~80% shipped; remaining
#215a/b/c). Sibling Phase-A batches: backend #623/#627/#681, tooling #816.
