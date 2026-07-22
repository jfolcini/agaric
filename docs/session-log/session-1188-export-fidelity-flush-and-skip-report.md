## Session 1188 — export flush-before-export + Export-All skip reporting (2026-07-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-22 |
| **Subagents** | 1 build + 1 review (frontend) |
| **Items closed** | `#2969` `#2965` |
| **Files touched** | 6 source (1 new) + 4 test |

**Summary:** Two frontend export-fidelity fixes.

- **#2969** — the editor commits typed content on a 700ms idle debounce
  (`useDebouncedContentCommit`), so exporting right after typing (esp. `Ctrl+Shift+E`,
  which never blurs) could miss the newest keystrokes. Both export entry points live
  outside the `BlockTree` subtree that owns the focused editor, with no ref path to it.
  Added a minimal module-singleton bridge (`src/lib/active-draft-flush.ts`): the focused
  block registers a flush; `PageHeader.copyPageMarkdownToClipboard` and
  `exportGraphAsZip` `await flushActiveDraft()` before reading content. A stale-guard
  keeps out-of-order unmounts from clobbering a newer registration. (Documented
  limitation: covers the content-commit debounce path — the case the bug is about —
  not blur-only checkbox/paragraph-split handling, which commits via other paths.)
- **#2965** — `exportGraphAsZip` caught per-page/attachment failures but still reported
  success. It now returns `{blob, exportedPages, skippedPages, skippedAttachments}`
  (attachments deduped by id), writes an `export-report.txt` into the ZIP when anything
  was skipped, and `DataTab.handleExportAll` shows a warning toast (vs success) listing
  the skipped counts. Zero-skip happy path is unchanged.

**Files touched:**
- `src/lib/active-draft-flush.ts` (new), `src/hooks/useDebouncedContentCommit.ts`,
  `src/components/pages/PageHeader.tsx`, `src/lib/export-graph.ts`,
  `src/components/settings/DataTab.tsx`, `src/lib/i18n/common.ts` (+ 4 test files)

**Verification:**
- `tsc -b --noEmit` 0 errors (reviewer fixed a test-only `InvokeArgs` type error);
  oxlint clean; vitest 220/220 across the 4 touched suites.
- Playwright e2e: `e2e/import-export.spec.ts` 16/16 (single-page export, Export-All ZIP,
  round-trip fidelity) — no regression from the flush + return-type change.
- Reviewer adversarially verified the flush registry (single active registration,
  awaited commit not fire-and-forget, no leak, multi-BlockTree safe) and the skip
  dedup/report/happy-path.

**Commit plan:** single PR (own branch); merge when green.
